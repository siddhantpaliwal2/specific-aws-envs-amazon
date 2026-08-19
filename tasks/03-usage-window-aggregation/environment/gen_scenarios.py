#!/usr/bin/env python3
"""Build the account documents the emulated CloudWatch endpoint serves.

Two documents come out of here:

* `sandbox/public.json` -- the account the box serves to itself. Tame: one
  customer, one window, four dimensions, short pages.
* `verifier-data/holdout.json` -- the account the verifier serves. Same
  hazards, more of them at once, plus readings that belong to other customers,
  other businesses, other dimensions and other namespaces.

`verifier-data/run-spec.json` describes the calls the verifier makes: which
business, which customer, which window, and the offering document a caller
would hand in. The reference answers are never written down anywhere; the
scorer re-derives them from the account document.

Nothing in here enters the image. Run it from the environment directory:

    python3 gen_scenarios.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

REGION = "us-east-1"
ACCOUNT_ID = "400000000001"
NAMESPACE = "Metering/Usage"
METRIC_NAME = "DimensionUsage"

# Readings arrive at most once a minute per series, which is the granularity the
# usage reader asks CloudWatch for.
SERIES_UNIT = "Count"


def series(business: str, customer: str, dimension: str, points, metadata=None) -> dict:
    dimensions = {"BusinessId": business, "CustomerId": customer, "DimensionId": dimension}
    for key, value in (metadata or {}).items():
        dimensions[f"Metadata_{key}"] = value
    return {
        "namespace": NAMESPACE,
        "metric_name": METRIC_NAME,
        "dimensions": dimensions,
        "unit": SERIES_UNIT,
        "points": [[timestamp, value] for timestamp, value in points],
    }


def dimension(
    dimension_id: str,
    name: str,
    interval: str,
    method: str,
    sample_type: str = "gauge",
    group_keys: dict | None = None,
) -> dict:
    """An offering's view of a dimension, as a caller hands it in."""
    entry = {
        "dimensionId": dimension_id,
        "dimensionName": name,
        "aggregationInterval": interval,
        "aggregationMethod": method,
        "sampleType": sample_type,
        "usageIncrement": "1",
        "rounding": "round",
        "consumptionUnit": {"unit": "count-based", "type": "count"},
        "paymentSchedule": "upfront" if sample_type == "continious" else "arrear",
    }
    if group_keys:
        entry["tiersGroupByMetadata"] = [
            {
                "metadataGroups": group_keys,
                "tiers": [{"lowerLimit": "0", "upperLimit": "inf", "price": "0.01"}],
            }
        ]
    return entry


# ---------------------------------------------------------------------------
# the sandbox account
# ---------------------------------------------------------------------------


def sandbox() -> dict:
    business = "demo-labs"
    customer = "cus_sandbox01"
    metrics = [
        # A gauge with readings on either side of the window and an hour in the
        # middle nobody used.
        series(
            business,
            customer,
            "dim_widgets",
            [
                ("2024-02-14T00:15:00Z", 4),
                ("2024-02-14T00:45:00Z", 1),
                ("2024-02-14T00:50:00Z", 2),
                ("2024-02-14T00:55:00Z", 1),
                ("2024-02-14T02:02:00Z", 2),
                ("2024-02-14T02:05:00Z", 6),
                ("2024-02-14T02:10:00Z", 1),
                ("2024-02-14T02:35:00Z", 9),
            ],
        ),
        # A level that was set a fortnight before the window and moved once
        # inside it.
        series(
            business,
            customer,
            "dim_licences",
            [("2024-01-30T12:00:00Z", 2), ("2024-02-14T01:15:00Z", 5)],
        ),
        # Two metadata groups, each with readings of its own.
        series(
            business,
            customer,
            "dim_egress_gb",
            [("2024-02-14T00:45:00Z", 3), ("2024-02-14T02:05:00Z", 1)],
            metadata={"environment": "production"},
        ),
        series(
            business,
            customer,
            "dim_egress_gb",
            [("2024-02-14T01:10:00Z", 9)],
            metadata={"environment": "staging"},
        ),
        # dim_quiet has never been sent a reading, so it publishes no series.
        # Another customer of the same business, to be stepped around.
        series(
            business,
            "cus_sandbox02",
            "dim_widgets",
            [("2024-02-14T01:05:00Z", 500)],
        ),
    ]
    return {
        "region": REGION,
        "bootstrap_identity": {
            "account_id": ACCOUNT_ID,
            "access_key_id": "AKIAMETERINGUSAGE01",
            "secret_access_key": "usage-secret",
        },
        "accounts": [{"account_id": ACCOUNT_ID, "alias": "metering-usage", "metrics": metrics}],
        "faults": {
            "enabled": True,
            "rules": [
                {"service": "cloudwatch", "action": "GetMetricData", "max_page_size": 5},
                {"service": "cloudwatch", "action": "ListMetrics", "max_page_size": 1},
            ],
        },
    }


# ---------------------------------------------------------------------------
# the held-out account
# ---------------------------------------------------------------------------

BUSINESS = "harperdb-cloud"
HOURLY_CUSTOMER = "cus_9fbb31d2"
DAILY_CUSTOMER = "cus_4a07e6c1"


def holdout() -> dict:
    metrics = [
        # -- the customer read over an hourly window that starts and ends
        #    part way through an hour ----------------------------------------
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_api_calls",
            [
                ("2024-03-05T00:05:00Z", 9),
                ("2024-03-05T00:25:00Z", 5),
                ("2024-03-05T00:40:00Z", 7),
                ("2024-03-05T00:55:00Z", 1),
                ("2024-03-05T01:10:00Z", 3),
                ("2024-03-05T01:30:00Z", 2),
                ("2024-03-05T01:45:00Z", 6),
                ("2024-03-05T03:05:00Z", 11),
                ("2024-03-05T03:20:00Z", 4),
                ("2024-03-05T03:35:00Z", 8),
                ("2024-03-05T03:50:00Z", 13),
            ],
        ),
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_seats",
            [("2024-01-25T09:00:00Z", 4), ("2024-03-05T02:15:00Z", 6)],
        ),
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_reserved_gb",
            [("2024-02-20T00:00:00Z", 15), ("2024-03-05T01:20:00Z", 25)],
        ),
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_storage_gb",
            [("2024-03-05T00:30:00Z", 10), ("2024-03-05T02:10:00Z", 4)],
            metadata={"region": "us-east-1"},
        ),
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_storage_gb",
            [("2024-03-05T01:05:00Z", 8), ("2024-03-05T03:10:00Z", 2)],
            metadata={"region": "eu-west-1"},
        ),
        # -- the customer read over three whole days -------------------------
        series(
            BUSINESS,
            DAILY_CUSTOMER,
            "dim_backup_jobs",
            [
                ("2024-03-01T04:00:00Z", 3),
                ("2024-03-01T09:00:00Z", 7),
                ("2024-03-03T02:00:00Z", 5),
            ],
        ),
        series(
            BUSINESS,
            DAILY_CUSTOMER,
            "dim_seat_hours",
            [("2024-03-01T10:00:00Z", 6), ("2024-03-03T11:00:00Z", 4)],
            metadata={"plan": "gold"},
        ),
        series(
            BUSINESS,
            DAILY_CUSTOMER,
            "dim_seat_hours",
            [("2024-03-02T08:00:00Z", 2), ("2024-03-02T20:00:00Z", 5)],
            metadata={"plan": "silver"},
        ),
        # dim_idle_gb has never been sent a reading.
        # -- readings that belong to somebody else ---------------------------
        series(
            BUSINESS,
            "cus_00000000",
            "dim_api_calls",
            [("2024-03-05T00:30:00Z", 900), ("2024-03-05T02:30:00Z", 900)],
        ),
        series(
            "other-business",
            HOURLY_CUSTOMER,
            "dim_api_calls",
            [("2024-03-05T00:30:00Z", 700), ("2024-03-05T02:30:00Z", 700)],
        ),
        series(
            BUSINESS,
            HOURLY_CUSTOMER,
            "dim_not_in_the_offering",
            [("2024-03-05T00:30:00Z", 400)],
        ),
        {
            "namespace": "AWS/EC2",
            "metric_name": "NetworkOut",
            "dimensions": {"InstanceId": "i-0af31c92b5d7e4410"},
            "unit": "Bytes",
            "points": [["2024-03-05T00:30:00Z", 123456.0]],
        },
    ]
    return {
        "region": REGION,
        "bootstrap_identity": {
            "account_id": ACCOUNT_ID,
            "access_key_id": "AKIAMETERINGUSAGE01",
            "secret_access_key": "usage-secret",
        },
        "accounts": [{"account_id": ACCOUNT_ID, "alias": "metering-usage", "metrics": metrics}],
        "faults": {
            "enabled": True,
            "rules": [
                {"service": "cloudwatch", "action": "GetMetricData", "max_page_size": 4},
                {"service": "cloudwatch", "action": "ListMetrics", "max_page_size": 1},
            ],
        },
    }


def run_spec() -> dict:
    return {
        "region": REGION,
        "runs": [
            {
                "label": "hourly-partial-window",
                "businessID": BUSINESS,
                "customerId": HOURLY_CUSTOMER,
                "startTime": "2024-03-05T00:20:00Z",
                "endTime": "2024-03-05T03:40:00Z",
                "offering": {
                    "offeringId": "off_7c1a44e0",
                    "offeringName": "growth",
                    "dimensions": [
                        dimension("dim_api_calls", "API calls", "hour", "sum"),
                        dimension("dim_seats", "Seats", "hour", "max", sample_type="continious"),
                        dimension(
                            "dim_reserved_gb", "Reserved storage", "hour", "sum", sample_type="continious"
                        ),
                        dimension(
                            "dim_storage_gb",
                            "Storage",
                            "hour",
                            "sum",
                            group_keys={"region": "us-east-1"},
                        ),
                    ],
                },
            },
            {
                "label": "daily-whole-window",
                "businessID": BUSINESS,
                "customerId": DAILY_CUSTOMER,
                "startTime": "2024-03-01T00:00:00Z",
                "endTime": "2024-03-04T00:00:00Z",
                "offering": {
                    "offeringId": "off_31b9c7d5",
                    "offeringName": "enterprise",
                    "dimensions": [
                        dimension("dim_backup_jobs", "Backup jobs", "day", "count"),
                        dimension("dim_idle_gb", "Idle storage", "day", "sum"),
                        dimension(
                            "dim_seat_hours",
                            "Seat hours",
                            "day",
                            "sum",
                            group_keys={"plan": "gold"},
                        ),
                    ],
                },
            },
        ],
    }


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=False)
        handle.write("\n")
    print(f"wrote {path.relative_to(HERE)}")


def main() -> None:
    write(HERE / "sandbox" / "public.json", sandbox())
    write(HERE / "verifier-data" / "holdout.json", holdout())
    write(HERE / "verifier-data" / "run-spec.json", run_spec())


if __name__ == "__main__":
    main()
