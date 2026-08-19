#!/usr/bin/env python3
"""Trusted scorer. Runs as root, loads no submitted code.

It re-derives the attribution straight from the held-out account document: every
usage line every onboarded account exported, walked from the pocket it names
through however many hand-offs stand between that pocket and the code that ends
up carrying the money, then totalled per code. That is compared against what the
submission actually produced when the driver called it. The submission never
sees this file, the scenario, or the derived answers.

Reward is binary. A walk that stops at the first hand-off, or at the second, or
that never learns to read one of the four places a hand-off can point, produces
a perfectly well-formed report with plausible figures against the wrong codes,
and scores zero.
"""

from __future__ import annotations

import argparse
import json
import os

POOL = "pool/"
UNIT = "unit/"
NODE = "node/"
ALIAS = "alias/"
ALIAS_PARAMETER_ROOT = "/metering/attribution/alias/"
CHARGE_CODE_TAG = "meteringChargeCode"
ROLLUP_TAG = "meteringRollsInto"

NUMBER_FIELDS = ("quantity", "amount", "lineCount")


# ---------------------------------------------------------------------------
# reference model
# ---------------------------------------------------------------------------


class Estate:
    """Every store the attribution material is spread across, read straight out
    of the account document rather than over the wire."""

    def __init__(self, scenario: dict) -> None:
        self.buckets: dict[str, dict[str, dict]] = {}
        self.aliases: dict[str, str] = {}
        self.nodes: dict[tuple[str, str, str], dict[str, str]] = {}

        for account in scenario.get("accounts", []):
            for bucket in account.get("buckets", []) or []:
                objects = self.buckets.setdefault(bucket["name"], {})
                for obj in bucket.get("objects", []) or []:
                    objects[obj["key"]] = obj.get("body_json") or {}
            for name, value in (account.get("parameters") or {}).items():
                if name.startswith(ALIAS_PARAMETER_ROOT):
                    self.aliases[name[len(ALIAS_PARAMETER_ROOT) :]] = value
            for instance in account.get("instances", []) or []:
                region = instance.get("region") or instance.get("availability_zone", "")[:-1]
                key = (account["account_id"], region, instance["instance_id"])
                self.nodes[key] = dict(instance.get("tags") or {})

        self.pools: dict[str, dict] = {}
        self.units: dict[str, dict] = {}

    def load_attribution(self, bucket: str, prefix: str) -> None:
        objects = self.buckets.get(bucket, {})
        self.pools = (objects.get(f"{prefix}pools.json") or {}).get("pools") or {}
        unit_prefix = f"{prefix}units/"
        for key, body in objects.items():
            if key.startswith(unit_prefix) and key.endswith(".json"):
                self.units[key[len(unit_prefix) : -len(".json")]] = body

    def record(self, reference: str) -> dict | None:
        """`{code, delegate}` for one reference, or None when nothing answers."""
        if reference.startswith(POOL):
            entry = self.pools.get(reference[len(POOL) :])
            return None if entry is None else {"code": entry.get("chargeCode"), "delegate": entry.get("rollsUpTo")}
        if reference.startswith(UNIT):
            entry = self.units.get(reference[len(UNIT) :])
            return None if entry is None else {"code": entry.get("chargeCode"), "delegate": entry.get("parentRef")}
        if reference.startswith(NODE):
            parts = reference[len(NODE) :].split("/")
            if len(parts) != 3:
                return None
            tags = self.nodes.get((parts[0], parts[1], parts[2]))
            return None if tags is None else {"code": tags.get(CHARGE_CODE_TAG), "delegate": tags.get(ROLLUP_TAG)}
        return None

    def charge_code(self, reference: str) -> str | None:
        """The code a reference finally lands on.

        A hand-off is followed until a record has none left. A reference already
        stood on ends the walk: every record inside such a loop books to the
        same code, so where the walk stops inside one cannot change the answer.
        """
        seen: set[str] = set()
        pointer = reference
        code: str | None = None
        while pointer and pointer not in seen:
            seen.add(pointer)
            if pointer.startswith(ALIAS):
                pointer = self.aliases.get(pointer[len(ALIAS) :])
                continue
            record = self.record(pointer)
            if record is None:
                return code
            code = record.get("code") or code
            pointer = record.get("delegate")
        return code


def expected_rows(scenario: dict, run: dict) -> dict[str, dict]:
    estate = Estate(scenario)
    registry = estate.buckets.get(run["registryBucket"], {}).get(run["registryKey"]) or {}
    estate.load_attribution(run["registryBucket"], registry.get("attributionPrefix", "attribution/"))

    usage_prefix = registry.get("usageExportPrefix", "usage/")
    totals: dict[str, dict] = {}
    for account in registry.get("accounts", []) or []:
        objects = estate.buckets.get(account.get("usageBucket", ""), {})
        wanted = f"{usage_prefix}{account['accountId']}/"
        for key in sorted(objects):
            if not key.startswith(wanted):
                continue
            for line in (objects[key] or {}).get("lines", []) or []:
                code = estate.charge_code(line.get("attribution", ""))
                if not code:
                    continue
                running = totals.setdefault(code, {"quantity": 0.0, "amount": 0.0, "lineCount": 0})
                running["quantity"] += float(line.get("quantity", 0.0))
                running["amount"] += float(line.get("amount", 0.0))
                running["lineCount"] += 1
    return totals


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------


def close(left: float, right: float) -> bool:
    return abs(left - right) <= max(1e-6, abs(right) * 1e-9)


def grade(scenario: dict, spec: dict, observed: dict) -> tuple[bool, list[str]]:
    failures: list[str] = []
    if observed.get("fatal"):
        failures.append("the driver aborted before the report was produced")
        return False, failures

    runs = observed.get("runs") or {}
    for run in spec["runs"]:
        label = run["label"]
        actual = runs.get(label)
        if actual is None:
            failures.append(f"{label}: no result recorded")
            continue
        if not actual.get("ok"):
            failures.append(f"{label}: the call failed ({actual.get('error')})")
            continue

        expected = expected_rows(scenario, run)
        rows = actual.get("rows")
        if not isinstance(rows, list):
            failures.append(f"{label}: the response was not a list")
            continue

        seen: dict[str, dict] = {}
        malformed = False
        for row in rows:
            if not isinstance(row, dict) or not row.get("chargeCode"):
                failures.append(f"{label}: a row carried no charge code")
                malformed = True
                break
            code = str(row["chargeCode"])
            if code in seen:
                failures.append(f"{label}: reported {code} more than once")
                malformed = True
                break
            seen[code] = row
        if malformed:
            continue

        missing = sorted(set(expected) - set(seen))
        extra = sorted(set(seen) - set(expected))
        if missing:
            failures.append(
                f"{label}: {len(missing)} of {len(expected)} charge codes absent from the report, "
                f"first few {missing[:5]}"
            )
        if extra:
            failures.append(
                f"{label}: {len(extra)} charge codes reported that nothing is attributed to, first few {extra[:5]}"
            )

        for code in sorted(set(expected) & set(seen)):
            want, got = expected[code], seen[code]
            for field in NUMBER_FIELDS:
                try:
                    value = float(got.get(field))
                except (TypeError, ValueError):
                    failures.append(f"{label}: {code} {field} was not a number ({got.get(field)!r})")
                    continue
                if not close(value, float(want[field])):
                    failures.append(f"{label}: {code} {field} was {value}, expected {want[field]}")

    return not failures, failures


# ---------------------------------------------------------------------------


def emit(output_dir: str, reward: float, failures: list[str], note: str = "") -> None:
    os.makedirs(output_dir, exist_ok=True)
    payload = {"reward": reward, "score": reward}
    with open(os.path.join(output_dir, "reward.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    with open(os.path.join(output_dir, "reward.txt"), "w", encoding="utf-8") as handle:
        handle.write(f"{reward}\n")
    with open(os.path.join(output_dir, "report.txt"), "w", encoding="utf-8") as handle:
        if note:
            handle.write(f"{note}\n")
        for line in failures:
            handle.write(f"{line}\n")
        handle.write(f"reward={reward}\n")
    print(f"reward={reward}")
    for line in failures[:40]:
        print(f"  - {line}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--fail")
    parser.add_argument("--scenario")
    parser.add_argument("--spec")
    parser.add_argument("--observed")
    args = parser.parse_args()

    if args.fail:
        emit(args.output_dir, 0.0, [args.fail], note="harness precondition not met")
        return

    for label, path in (("scenario", args.scenario), ("spec", args.spec), ("observed", args.observed)):
        if not path or not os.path.exists(path):
            emit(args.output_dir, 0.0, [f"{label} file is missing"], note="nothing to score")
            return

    with open(args.scenario, encoding="utf-8") as handle:
        scenario = json.load(handle)
    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)
    try:
        with open(args.observed, encoding="utf-8") as handle:
            observed = json.load(handle)
    except json.JSONDecodeError:
        emit(args.output_dir, 0.0, ["the driver produced no readable output"], note="nothing to score")
        return

    passed, failures = grade(scenario, spec, observed)
    emit(args.output_dir, 1.0 if passed else 0.0, failures)


if __name__ == "__main__":
    main()
