#!/usr/bin/env python3
"""Build the mock-AWS scenario documents this task runs against.

Two documents come out of here:

  public.json   the account the sandbox serves. Two onboarded accounts, a
                handful of instances, every ownership situation present once.

  holdout.json  the account the verifier serves. Same wire shape, four
                onboarded accounts, more customers, three-way sharing, claims
                that cross an account boundary, and several instances that
                belong to nobody.

Both are pure functions of the literals below, so `compute_reward.py` can
re-derive the expected attribution from the document itself rather than from a
stored answer key.
"""

from __future__ import annotations

import argparse
import json
import os

REGION = "us-east-1"
BOOTSTRAP_KEY = "AKIAMETERINGMETER01"
ROLE_NAME = "metering-metering"


def trust_policy(metering_account: str, external_id: str) -> dict:
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "sts:AssumeRole",
                "Principal": {"AWS": f"arn:aws:iam::{metering_account}:root"},
                "Condition": {"StringEquals": {"sts:ExternalId": external_id}},
            }
        ],
    }


def instance(
    instance_id: str,
    instance_type: str,
    tags: dict[str, str],
    state: str = "running",
    launch: str = "2026-01-04T09:00:00Z",
) -> dict:
    return {
        "instance_id": instance_id,
        "instance_type": instance_type,
        "launch_time": launch,
        "state": state,
        "tags": tags,
        "platform_details": "Linux/UNIX",
    }


def tenant_account(account_id: str, external_id: str, metering_account: str, instances: list[dict]) -> dict:
    return {
        "account_id": account_id,
        "alias": f"tenant-{account_id[-4:]}",
        "roles": [
            {
                "name": ROLE_NAME,
                "trust_policy": trust_policy(metering_account, external_id),
            }
        ],
        "instances": instances,
    }


def registry_account(account_id: str, external_id: str) -> dict:
    return {
        "accountId": account_id,
        "roleArn": f"arn:aws:iam::{account_id}:role/{ROLE_NAME}",
        "externalId": external_id,
        "region": REGION,
    }


def metering_account_entry(
    account_id: str, bucket: str, registry_key: str, registry: dict, customers: list[dict], prefix: str
) -> dict:
    objects = [{"key": registry_key, "body_json": registry, "last_modified": "2026-01-02T00:00:00Z"}]
    for record in customers:
        objects.append(
            {
                "key": f"{prefix}{record['customerId']}.json",
                "body_json": record,
                "last_modified": "2026-01-02T00:00:00Z",
            }
        )
    return {
        "account_id": account_id,
        "alias": "metering-metering",
        "buckets": [{"name": bucket, "region": REGION, "objects": objects}],
    }


FAULTS = {
    "enabled": True,
    "rules": [
        # Short pages on the inventory read. The collector already walks the
        # token chain, so this only keeps the wire honest.
        {"service": "ec2", "action": "DescribeInstances", "max_page_size": 3},
    ],
}


# --------------------------------------------------------------------------
# sandbox
# --------------------------------------------------------------------------

PUBLIC_METERING = "900000000001"
PUBLIC_BUCKET = "metering-metering-cadence"
PUBLIC_PREFIX = "onboarding/customers/"
PUBLIC_REGISTRY_KEY = "onboarding/registry.json"
PUBLIC_DIMENSION = "dim-uptime-sandbox"
PUBLIC_BUSINESS = "biz-cadence"

PUBLIC_A1 = "100000000011"
PUBLIC_A2 = "100000000022"


def build_public() -> dict:
    dim = PUBLIC_DIMENSION

    a1 = tenant_account(
        PUBLIC_A1,
        "cadence-a1-4f21",
        PUBLIC_METERING,
        [
            instance("i-0sbx000000000001", "m5.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_harbor"}),
            instance("i-0sbx000000000002", "m5.large", {"meteringDimensionId": dim}),
            instance("i-0sbx000000000003", "t3.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_lattice"}),
            instance(
                "i-0sbx000000000004",
                "t3.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_harbor"},
                state="stopped",
            ),
            instance(
                "i-0sbx000000000005",
                "c6i.large",
                {"meteringDimensionId": "dim-egress-sandbox", "meteringCustomerId": "cus_harbor"},
            ),
            instance("i-0sbx000000000006", "t3.small", {"Name": "bastion"}),
        ],
    )
    a2 = tenant_account(
        PUBLIC_A2,
        "cadence-a2-9b07",
        PUBLIC_METERING,
        [
            instance(
                "i-0sbx000000000011",
                "m6i.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_harbor,cus_lattice"},
            ),
            instance("i-0sbx000000000012", "m6i.large", {"meteringDimensionId": dim}),
            instance(
                "i-0sbx000000000013",
                "r6i.large",
                {"meteringDimensionId": f"{dim},dim-egress-sandbox", "meteringCustomerId": "cus_lattice"},
            ),
        ],
    )

    registry = {
        "businessID": PUBLIC_BUSINESS,
        "customerRecordPrefix": PUBLIC_PREFIX,
        "accounts": [
            registry_account(PUBLIC_A1, "cadence-a1-4f21"),
            registry_account(PUBLIC_A2, "cadence-a2-9b07"),
        ],
    }
    customers = [
        {
            "customerId": "cus_harbor",
            "displayName": "Harbor Analytics",
            "accounts": [{"accountId": PUBLIC_A1, "dedicated": True}, {"accountId": PUBLIC_A2}],
        },
        {
            "customerId": "cus_lattice",
            "displayName": "Lattice Robotics",
            "accounts": [{"accountId": PUBLIC_A2}],
        },
    ]

    return {
        "region": REGION,
        "bootstrap_identity": {"account_id": PUBLIC_METERING, "access_key_id": BOOTSTRAP_KEY},
        "accounts": [
            metering_account_entry(
                PUBLIC_METERING, PUBLIC_BUCKET, PUBLIC_REGISTRY_KEY, registry, customers, PUBLIC_PREFIX
            ),
            a1,
            a2,
        ],
        "faults": FAULTS,
    }


# --------------------------------------------------------------------------
# held-out account
# --------------------------------------------------------------------------

HOLDOUT_METERING = "900000000009"
HOLDOUT_BUCKET = "metering-metering-bravado"
HOLDOUT_PREFIX = "onboarding/tenants/"
HOLDOUT_REGISTRY_KEY = "onboarding/accounts.json"
HOLDOUT_DIMENSION = "dim-uptime"
HOLDOUT_BUSINESS = "biz-bravado"

B1 = "200000000011"
B2 = "200000000022"
B3 = "200000000033"
B4 = "200000000044"


def build_holdout() -> dict:
    dim = HOLDOUT_DIMENSION
    other = "dim-egress"

    b1 = tenant_account(
        B1,
        "bravado-b1-1c8e",
        HOLDOUT_METERING,
        [
            instance("i-0hld000000000101", "m5.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_vantage"}),
            instance("i-0hld000000000102", "m5.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_dormant"}),
            instance("i-0hld000000000103", "t3.large", {"meteringDimensionId": dim}),
            instance(
                "i-0hld000000000104",
                "t3.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_vantage"},
                state="stopped",
            ),
            instance("i-0hld000000000105", "c6i.large", {"meteringDimensionId": other, "meteringCustomerId": "cus_vantage"}),
            instance(
                "i-0hld000000000106",
                "m6i.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_vantage,cus_dormant"},
            ),
            instance("i-0hld000000000107", "t3.small", {"Name": "jump-host"}),
        ],
    )

    b2 = tenant_account(
        B2,
        "bravado-b2-77a3",
        HOLDOUT_METERING,
        [
            instance("i-0hld000000000201", "m5.xlarge", {"meteringDimensionId": dim, "meteringCustomerId": "cus_orbital"}),
            instance(
                "i-0hld000000000202",
                "m5.xlarge",
                {"meteringDimensionId": f"{other},{dim}", "meteringCustomerId": "cus_orbital"},
            ),
            instance(
                "i-0hld000000000203",
                "r6i.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_orbital,cus_orbital"},
            ),
            instance("i-0hld000000000204", "r6i.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_relict"}),
            instance(
                "i-0hld000000000205",
                "t3.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_orbital"},
                state="terminated",
            ),
        ],
    )

    b3 = tenant_account(
        B3,
        "bravado-b3-2d55",
        HOLDOUT_METERING,
        [
            instance(
                "i-0hld000000000301",
                "c6i.2xlarge",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_vantage,cus_orbital,cus_pinnacle"},
            ),
            instance(
                "i-0hld000000000302",
                "c6i.xlarge",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_vantage, cus_pinnacle"},
            ),
            instance("i-0hld000000000303", "m6i.large", {"meteringDimensionId": dim}),
            instance("i-0hld000000000304", "m6i.large", {"meteringDimensionId": dim, "meteringCustomerId": "cus_quarry"}),
            instance(
                "i-0hld000000000305",
                "m6i.xlarge",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_quarry,cus_orbital"},
            ),
            instance("i-0hld000000000306", "t3.medium", {"meteringDimensionId": other, "meteringCustomerId": "cus_pinnacle"}),
        ],
    )

    b4 = tenant_account(
        B4,
        "bravado-b4-6e10",
        HOLDOUT_METERING,
        [
            instance("i-0hld000000000401", "m5.2xlarge", {"meteringDimensionId": dim, "meteringCustomerId": "cus_pinnacle"}),
            instance(
                "i-0hld000000000402",
                "m5.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_pinnacle,cus_quarry"},
            ),
            instance("i-0hld000000000403", "t3.large", {"meteringDimensionId": dim, "meteringCustomerId": ""}),
            instance(
                "i-0hld000000000404",
                "t3.large",
                {"meteringDimensionId": dim, "meteringCustomerId": "cus_quarry"},
                state="stopped",
            ),
        ],
    )

    registry = {
        "businessID": HOLDOUT_BUSINESS,
        "customerRecordPrefix": HOLDOUT_PREFIX,
        "accounts": [
            registry_account(B1, "bravado-b1-1c8e"),
            registry_account(B2, "bravado-b2-77a3"),
            registry_account(B3, "bravado-b3-2d55"),
            registry_account(B4, "bravado-b4-6e10"),
        ],
    }
    customers = [
        {
            "customerId": "cus_vantage",
            "displayName": "Vantage Freight",
            "accounts": [{"accountId": B1, "dedicated": True}, {"accountId": B3}],
        },
        {
            "customerId": "cus_orbital",
            "displayName": "Orbital Media",
            "accounts": [{"accountId": B2, "dedicated": True}, {"accountId": B3}],
        },
        {
            "customerId": "cus_pinnacle",
            "displayName": "Pinnacle Health",
            "accounts": [{"accountId": B3}, {"accountId": B4}],
        },
        {
            "customerId": "cus_quarry",
            "displayName": "Quarry Logistics",
            "accounts": [{"accountId": B4}],
        },
        {
            "customerId": "cus_dormant",
            "displayName": "Dormant Ventures",
            "accounts": [{"accountId": B2}],
        },
        {
            "customerId": "cus_relict",
            "displayName": "Relict Industries",
            "accounts": [{"accountId": "299999999999"}],
        },
    ]

    return {
        "region": REGION,
        "bootstrap_identity": {"account_id": HOLDOUT_METERING, "access_key_id": BOOTSTRAP_KEY},
        "accounts": [
            metering_account_entry(
                HOLDOUT_METERING, HOLDOUT_BUCKET, HOLDOUT_REGISTRY_KEY, registry, customers, HOLDOUT_PREFIX
            ),
            b1,
            b2,
            b3,
            b4,
        ],
        "faults": FAULTS,
    }


def build_run_spec() -> dict:
    return {
        "runs": [
            {
                "label": "monthly-uptime",
                "businessID": HOLDOUT_BUSINESS,
                "dimensionId": HOLDOUT_DIMENSION,
                "registryBucket": HOLDOUT_BUCKET,
                "registryKey": HOLDOUT_REGISTRY_KEY,
            },
            {
                "label": "egress-dimension",
                "businessID": HOLDOUT_BUSINESS,
                "dimensionId": "dim-egress",
                "registryBucket": HOLDOUT_BUCKET,
                "registryKey": HOLDOUT_REGISTRY_KEY,
            },
        ]
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--verifier-dir", required=True)
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(args.verifier_dir, exist_ok=True)

    documents = [
        (os.path.join(args.out_dir, "public.json"), build_public()),
        (os.path.join(args.verifier_dir, "holdout.json"), build_holdout()),
        (os.path.join(args.verifier_dir, "run-spec.json"), build_run_spec()),
    ]
    for path, document in documents:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=False)
            handle.write("\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
