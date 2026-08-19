#!/usr/bin/env python3
"""Trusted scorer. Runs as root, loads no submitted code.

It re-derives the usage each customer owes straight from the held-out scenario
document -- the onboarding records sitting in the metering bucket and the tags
on the instances in every onboarded account -- then compares that against what
the submission produced when the driver asked it for a run. The submission
never sees this file, the scenario, or the derived answers.

Reward is binary: every check passes, or the run is worth nothing.
"""

from __future__ import annotations

import argparse
import json
import os

# The increment one running instance contributes over a collection interval.
# Carried by the collector in the workspace; a submission has no reason to
# change it and the reward is scaled by it either way.
RUNNING_TIME_INCREMENT = 0.08333333


# ---------------------------------------------------------------------------
# reference model
# ---------------------------------------------------------------------------


def metering_bucket(scenario: dict, bucket_name: str) -> dict[str, dict]:
    """Every object body in the metering bucket, keyed by object key."""
    for account in scenario.get("accounts", []):
        for bucket in account.get("buckets", []):
            if bucket["name"] == bucket_name:
                return {obj["key"]: obj["body_json"] for obj in bucket.get("objects", [])}
    return {}


def tenant_directory(objects: dict[str, dict], prefix: str) -> tuple[dict[str, set], dict[str, str]]:
    """`(customers billable per account, the customer each account was stood up for)`."""
    billable: dict[str, set] = {}
    standing: dict[str, str] = {}
    for key, body in sorted(objects.items()):
        if not key.startswith(prefix) or key == prefix:
            continue
        customer_id = body.get("customerId")
        if not customer_id:
            continue
        for link in body.get("accounts", []):
            account_id = link["accountId"]
            billable.setdefault(account_id, set()).add(customer_id)
            if link.get("dedicated"):
                standing[account_id] = customer_id
    return billable, standing


def instances_of(scenario: dict, account_id: str) -> list[dict]:
    for account in scenario.get("accounts", []):
        if account["account_id"] == account_id:
            return account.get("instances", [])
    return []


def claimed_customers(tags: dict) -> list[str]:
    raw = tags.get("meteringCustomerId") or ""
    seen: list[str] = []
    for name in raw.split(","):
        trimmed = name.strip()
        if trimmed and trimmed not in seen:
            seen.append(trimmed)
    return seen


def expected_run(scenario: dict, run: dict) -> dict[str, float]:
    objects = metering_bucket(scenario, run["registryBucket"])
    registry = objects[run["registryKey"]]
    billable, standing = tenant_directory(objects, registry["customerRecordPrefix"])
    dimension = run["dimensionId"]

    totals: dict[str, float] = {}
    for account in registry["accounts"]:
        account_id = account["accountId"]
        for instance in instances_of(scenario, account_id):
            if instance.get("state", "running") != "running":
                continue
            tags = instance.get("tags", {})
            dimension_tag = tags.get("meteringDimensionId")
            if dimension_tag is None:
                continue
            if dimension not in dimension_tag.split(","):
                continue

            owners = [
                name for name in claimed_customers(tags) if name in billable.get(account_id, set())
            ]
            if not owners:
                fallback = standing.get(account_id)
                owners = [fallback] if fallback else []
            if not owners:
                # Nobody on record can carry it, so it is not billed at all.
                continue
            portion = RUNNING_TIME_INCREMENT / len(owners)
            for customer_id in owners:
                totals[customer_id] = totals.get(customer_id, 0.0) + portion
    return totals


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------


def close(left: float, right: float) -> bool:
    return abs(left - right) <= max(1e-9, abs(right) * 1e-6)


def grade(scenario: dict, spec: dict, observed: dict) -> tuple[bool, list[str]]:
    failures: list[str] = []
    if observed.get("fatal"):
        failures.append(f"driver aborted before producing any run: {observed['fatal'][:400]}")
        return False, failures

    runs = observed.get("runs") or {}
    for run in spec["runs"]:
        label = run["label"]
        actual = runs.get(label)
        if actual is None:
            failures.append(f"{label}: no result recorded")
            continue
        if not actual.get("ok"):
            failures.append(f"{label}: call failed ({actual.get('error')})")
            continue

        rows = actual.get("rows")
        if not isinstance(rows, list):
            failures.append(f"{label}: the collector produced no list of measurements")
            continue

        # A collector may report per account or once per customer; either way
        # the customer's bill is what the rows add up to.
        seen: dict[str, float] = {}
        malformed = False
        for row in rows:
            if not isinstance(row, dict):
                failures.append(f"{label}: malformed measurement in the result")
                malformed = True
                break
            customer_id = row.get("customerId")
            if not isinstance(customer_id, str) or not customer_id:
                failures.append(f"{label}: a measurement carries no customer")
                malformed = True
                break
            if row.get("dimensionId") not in (None, run["dimensionId"]):
                failures.append(
                    f"{label}: {customer_id} was measured against {row.get('dimensionId')}"
                )
                malformed = True
                break
            try:
                seen[customer_id] = seen.get(customer_id, 0.0) + float(row.get("recordValue"))
            except (TypeError, ValueError):
                failures.append(f"{label}: {customer_id} reported no usable recordValue")
                malformed = True
                break
        if malformed:
            continue

        expected = expected_run(scenario, run)
        seen = {customer_id: value for customer_id, value in seen.items() if value != 0.0}

        missing = sorted(set(expected) - set(seen))
        extra = sorted(set(seen) - set(expected))
        if missing:
            failures.append(f"{label}: absent from the result {missing}")
        if extra:
            failures.append(f"{label}: should not be in the result {extra}")
        for customer_id in sorted(set(expected) & set(seen)):
            want = expected[customer_id]
            got = seen[customer_id]
            if not close(got, want):
                failures.append(f"{label}: {customer_id} billed {got}, expected {want}")

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
