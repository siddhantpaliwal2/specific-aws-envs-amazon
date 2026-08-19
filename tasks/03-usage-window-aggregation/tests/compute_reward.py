#!/usr/bin/env python3
"""Trusted scorer. Runs as root, loads no submitted code.

It re-derives, straight from the held-out account document, the usage breakdown
each dimension of each customer's offering should come back with over the window
the driver asked for, then compares that against what the submission produced.
The submission never sees this file, the account document, or the derived
answers.

Reward is binary: every bucket of every dimension of every run matches, or the
run is worth nothing.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone

UTC = timezone.utc

NAMESPACE = "Metering/Usage"
METRIC_NAME = "DimensionUsage"
METADATA_PREFIX = "Metadata_"

STEP = {"hour": timedelta(hours=1), "day": timedelta(days=1)}


# ---------------------------------------------------------------------------
# reference model
# ---------------------------------------------------------------------------


def parse_instant(raw) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment.astimezone(UTC) if moment.tzinfo else moment.replace(tzinfo=UTC)


def floor_to(moment: datetime, interval: str) -> datetime:
    if interval == "day":
        return moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return moment.replace(minute=0, second=0, microsecond=0)


def boundaries(start: datetime, end: datetime, interval: str) -> list[datetime]:
    """The window start, every interval boundary strictly inside it, and the end."""
    step = STEP[interval]
    edges = [start]
    cursor = floor_to(start, interval)
    if cursor < start:
        cursor += step
    while cursor < end:
        if cursor > start:
            edges.append(cursor)
        cursor += step
    edges.append(end)
    return edges


def aligned_grid(first: datetime, end: datetime, interval: str) -> list[tuple[datetime, datetime]]:
    """Interval-aligned buckets covering `first` up to `end`, the last one clipped."""
    step = STEP[interval]
    grid = []
    cursor = floor_to(first, interval)
    while cursor < end:
        grid.append((cursor, min(cursor + step, end)))
        cursor += step
    return grid


def reduce_samples(values: list[float], method: str) -> float:
    if not values:
        return 0.0
    if method == "max":
        return max(values)
    if method == "min":
        return min(values)
    if method == "average":
        return sum(values) / len(values)
    if method == "count":
        return float(len(values))
    if method == "last":
        return values[-1]
    return sum(values)


def series_of(scenario: dict) -> list[dict]:
    published = []
    for account in scenario.get("accounts", []):
        for entry in account.get("metrics", []):
            if entry.get("namespace") != NAMESPACE or entry.get("metric_name") != METRIC_NAME:
                continue
            published.append(
                {
                    "dimensions": dict(entry.get("dimensions", {})),
                    "points": sorted(
                        (parse_instant(point[0]), float(point[1])) for point in entry.get("points", [])
                    ),
                }
            )
    return published


def group_keys_of(dimension: dict) -> list[str]:
    groups = dimension.get("tiersGroupByMetadata") or []
    if not groups:
        return []
    return sorted((groups[0] or {}).get("metadataGroups", {}).keys())


def bags_for(published: list[dict], run: dict, dimension: dict) -> list[tuple[dict | None, list]]:
    """The readings behind a dimension, split per metadata group when it has any."""
    keys = group_keys_of(dimension)
    matching = [
        entry
        for entry in published
        if entry["dimensions"].get("BusinessId") == run["businessID"]
        and entry["dimensions"].get("CustomerId") == run["customerId"]
        and entry["dimensions"].get("DimensionId") == dimension["dimensionId"]
    ]
    if not keys:
        points: list = []
        for entry in matching:
            points.extend(entry["points"])
        return [(None, sorted(points))]

    bags: dict[tuple, list] = {}
    labels: dict[tuple, dict] = {}
    for entry in matching:
        if any(f"{METADATA_PREFIX}{key}" not in entry["dimensions"] for key in keys):
            continue
        identity = tuple(entry["dimensions"][f"{METADATA_PREFIX}{key}"] for key in keys)
        bags.setdefault(identity, []).extend(entry["points"])
        labels[identity] = {key: entry["dimensions"][f"{METADATA_PREFIX}{key}"] for key in keys}
    return [(labels[identity], sorted(bags[identity])) for identity in sorted(bags)]


def documents_for(
    points: list, run_start: datetime, run_end: datetime, dimension: dict
) -> list[tuple[float, datetime, datetime]]:
    """The buckets one bag of readings should come back as."""
    interval = dimension["aggregationInterval"]
    method = dimension["aggregationMethod"]
    continuous = dimension.get("sampleType") == "continious"
    edges = boundaries(run_start, run_end, interval)
    spans = list(zip(edges, edges[1:]))

    if continuous:
        history = [(moment, value) for moment, value in points if moment < run_end]
        if history:
            grid = aligned_grid(history[0][0], run_end, interval)
            carried: dict[datetime, float] = {}
            running = 0.0
            for bucket_start, bucket_end in grid:
                inside = [value for moment, value in history if bucket_start <= moment < bucket_end]
                if inside:
                    running = reduce_samples(inside, method)
                carried[bucket_end] = running
            # The reported spans join the window edges up; the value against
            # each of them is the one the aligned bucket ending there carries.
            return [
                (carried.get(span_end, 0.0), span_start, span_end) for span_start, span_end in spans
            ]
    else:
        inside_window = [
            (moment, value) for moment, value in points if run_start <= moment < run_end
        ]
        if inside_window:
            documents = []
            for span_start, span_end in spans:
                values = [
                    value for moment, value in inside_window if span_start <= moment < span_end
                ]
                documents.append((reduce_samples(values, method), span_start, span_end))
            return documents

    # Nothing was ever published for this bag, so the window still comes back
    # accounted for: one empty bucket per interval step across it.
    return [(0.0, span_start, span_end) for span_start, span_end in spans]


def expected_run(scenario: dict, run: dict) -> dict[tuple, list[tuple[float, datetime, datetime]]]:
    published = series_of(scenario)
    run_start = parse_instant(run["startTime"])
    run_end = parse_instant(run["endTime"])
    expected: dict[tuple, list] = {}
    for dimension in run["offering"]["dimensions"]:
        for label, points in bags_for(published, run, dimension):
            identity = (
                dimension["dimensionId"],
                tuple(sorted(label.items())) if label else None,
            )
            expected[identity] = documents_for(points, run_start, run_end, dimension)
    return expected


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------


def close(left: float, right: float) -> bool:
    return abs(left - right) <= max(1e-9, abs(right) * 1e-6)


def numeric(raw) -> float | None:
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            return float(raw.strip())
        except ValueError:
            return None
    return None


def observed_identity(row: dict, keys: list[str]) -> tuple | None:
    """The metadata group a row stands for, taken from the row or its buckets."""
    if not keys:
        return None
    carrier = row.get("metadataGroup")
    if not isinstance(carrier, dict) or not carrier:
        buckets = row.get("usage")
        first = buckets[0] if isinstance(buckets, list) and buckets else None
        carrier = first.get("metadataGroup") if isinstance(first, dict) else None
    if not isinstance(carrier, dict):
        return ()
    return tuple(sorted((key, str(carrier[key])) for key in keys if key in carrier))


def grade_run(label: str, run: dict, expected: dict, rows: list, failures: list[str]) -> None:
    keys_by_dimension = {
        dimension["dimensionId"]: group_keys_of(dimension)
        for dimension in run["offering"]["dimensions"]
    }

    seen: dict[tuple, list] = {}
    for row in rows:
        if not isinstance(row, dict):
            failures.append(f"{label}: a row of the answer is not a usage record")
            return
        dimension_id = row.get("dimensionId")
        if dimension_id not in keys_by_dimension:
            failures.append(f"{label}: {dimension_id!r} is not a dimension of the offering")
            return
        identity = (dimension_id, observed_identity(row, keys_by_dimension[dimension_id]))
        if identity in seen:
            failures.append(f"{label}: {dimension_id} came back more than once for {identity[1]}")
            return
        seen[identity] = row.get("usage")

    missing = sorted(str(key) for key in set(expected) - set(seen))
    extra = sorted(str(key) for key in set(seen) - set(expected))
    if missing:
        failures.append(f"{label}: absent from the answer {missing}")
    if extra:
        failures.append(f"{label}: should not be in the answer {extra}")

    for identity in sorted(set(expected) & set(seen), key=str):
        want = expected[identity]
        buckets = seen[identity]
        if not isinstance(buckets, list):
            failures.append(f"{label}: {identity[0]} came back with no usage buckets")
            continue
        if len(buckets) != len(want):
            failures.append(
                f"{label}: {identity[0]}{'' if identity[1] is None else ' ' + str(identity[1])} "
                f"came back as {len(buckets)} buckets, expected {len(want)}"
            )
            continue
        for index, (bucket, (value, start, end)) in enumerate(zip(buckets, want)):
            if not isinstance(bucket, dict):
                failures.append(f"{label}: {identity[0]} bucket {index} is not a usage document")
                break
            got = numeric(bucket.get("value"))
            if got is None:
                failures.append(
                    f"{label}: {identity[0]} bucket {index} carries no usable value "
                    f"({bucket.get('value')!r})"
                )
                break
            if not close(got, value):
                failures.append(
                    f"{label}: {identity[0]} bucket {index} is {got}, expected {value}"
                )
                break
            got_start = parse_instant(bucket.get("startTime"))
            got_end = parse_instant(bucket.get("endTime"))
            if got_start != start or got_end != end:
                failures.append(
                    f"{label}: {identity[0]} bucket {index} covers "
                    f"{bucket.get('startTime')}..{bucket.get('endTime')}, expected "
                    f"{start.isoformat()}..{end.isoformat()}"
                )
                break


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
            failures.append(f"{label}: the read failed ({actual.get('error')})")
            continue
        rows = actual.get("rows")
        if not isinstance(rows, list) or not rows:
            failures.append(f"{label}: the read produced no usage rows")
            continue
        grade_run(label, run, expected_run(scenario, run), rows, failures)

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
