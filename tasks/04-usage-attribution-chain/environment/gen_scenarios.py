#!/usr/bin/env python3
"""Build the two account documents this task is graded against.

Both documents describe the same world in the same shapes: a metering account
holding the business' onboarding record and its attribution material, plus a set
of onboarded accounts, each of which writes its own usage exports into its own
bucket and runs instances in more than one region.

A usage line never names the code its money is booked to. It names a pocket of
the estate, and a pocket very often hands the cost on to something else, which
may itself hand it on again. Those hand-offs land in four different places:

    pool/<name>                       a record inside attribution/pools.json
    unit/<name>                       a standalone object under attribution/units/
    node/<account>/<region>/<id>      tags on an EC2 instance in an onboarded account
    alias/<key>                       an SSM parameter whose value is another reference

The only differences between the two documents are dose and data. Every shape in
the held-out document appears in the sandbox too: every reference kind, every
record kind, the indirect alias hop, chains that close back on themselves, chains
that join into another chain's tail, and a chain as deep as the deepest one held
out. `python3 environment/gen_scenarios.py --check` proves that.

This generator never enters the image. Run it from the task directory:

    python3 environment/gen_scenarios.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

POOL = "pool/"
UNIT = "unit/"
NODE = "node/"
ALIAS = "alias/"
ALIAS_PARAMETER_ROOT = "/metering/attribution/alias/"
CHARGE_CODE_TAG = "meteringChargeCode"
ROLLUP_TAG = "meteringRollsInto"

# Every chain in either document is one of these. A document says how many
# chains of each shape it wants; nothing else about a chain's structure is
# adjustable, which is what keeps the two documents structurally identical.
#
#   steps       the records the chain walks through, in order. "alias" is not a
#               record: it makes the hand-off that follows it go through the
#               parameter tree instead of naming its target directly.
#   cycle_from  the chain's last record hands back to its own record at this
#               index instead of terminating. Every record from that index on
#               carries the same charge code, so where a walk stops inside the
#               loop cannot change the answer.
#   join        the chain's last record hands over to another shape's tail, so
#               two chains share everything below the join.
SHAPES: list[dict[str, Any]] = [
    {"name": "direct", "steps": ["pool"]},
    {"name": "unit-1", "steps": ["pool", "unit"]},
    {"name": "node-1", "steps": ["pool", "node"]},
    {"name": "alias-unit", "steps": ["pool", "alias", "unit"]},
    {"name": "unit-node", "steps": ["pool", "unit", "node"]},
    {"name": "node-unit", "steps": ["pool", "node", "unit"]},
    {"name": "unit-alias-node", "steps": ["pool", "unit", "alias", "node"]},
    {"name": "four", "steps": ["pool", "unit", "node", "unit"]},
    {"name": "five", "steps": ["pool", "alias", "unit", "node", "pool", "unit"]},
    {"name": "six", "steps": ["pool", "unit", "node", "alias", "unit", "node", "pool"]},
    {"name": "loop-short", "steps": ["pool", "unit"], "cycle_from": 0},
    {"name": "loop-long", "steps": ["pool", "unit", "alias", "pool"], "cycle_from": 1},
    {"name": "join-deep", "steps": ["pool", "unit"], "join": ("six", 2)},
    {"name": "join-mid", "steps": ["pool"], "join": ("four", 1)},
]

SHAPE_BY_NAME = {shape["name"]: shape for shape in SHAPES}

# Codes a chain can finish on. Within a document these are disjoint from the
# intermediate list below, so a walk that stops early can never land on a right
# answer by accident, and the two documents draw from disjoint slices so an
# answer memorised from the sandbox is worth nothing.
TERMINAL_CODES = [
    # sandbox slice
    "cc-platform-core",
    "cc-data-pipeline",
    "cc-edge-delivery",
    "cc-ml-training",
    "cc-shared-tooling",
    "cc-customer-apps",
    "cc-search-serving",
    "cc-media-encode",
    "cc-fraud-review",
    "cc-mobile-backend",
    "cc-partner-api",
    "cc-warehouse-etl",
    "cc-observability",
    "cc-identity-svc",
    "cc-batch-scoring",
    "cc-content-index",
    # held-out slice
    "cc-ledger-core",
    "cc-stream-ingest",
    "cc-cdn-origin",
    "cc-vision-train",
    "cc-devtools",
    "cc-checkout-apps",
    "cc-rank-serving",
    "cc-audio-encode",
    "cc-risk-review",
    "cc-tablet-backend",
    "cc-reseller-api",
    "cc-lakehouse-etl",
    "cc-telemetry",
    "cc-directory-svc",
    "cc-offline-eval",
    "cc-doc-index",
    "cc-billing-runs",
    "cc-notify-fanout",
    "cc-geo-routing",
    "cc-archive-tier",
    "cc-support-tools",
    "cc-sandbox-envs",
    "cc-model-registry",
    "cc-edge-cache",
]

# Codes that sit part way along a chain. They are drawn from the same naming
# convention as the terminal codes on purpose: nothing about the string says
# whether a code carries spend outright, so the only signal that a code hands
# the cost on is the delegation recorded against it. A report that stops early
# therefore looks entirely plausible.
INTERMEDIATE_CODES = [
    # sandbox slice
    "cc-queue-runners",
    "cc-asset-store",
    "cc-session-cache",
    "cc-api-gateway",
    "cc-log-shipping",
    "cc-thumbnailer",
    "cc-feature-flags",
    "cc-config-svc",
    "cc-email-relay",
    "cc-sms-fanout",
    "cc-graph-store",
    "cc-nightly-jobs",
    "cc-report-render",
    "cc-schema-svc",
    "cc-blob-gc",
    "cc-price-feed",
    "cc-consent-svc",
    "cc-crawler-farm",
    # held-out slice
    "cc-task-runners",
    "cc-object-store",
    "cc-token-cache",
    "cc-edge-gateway",
    "cc-trace-shipping",
    "cc-image-resize",
    "cc-toggle-svc",
    "cc-settings-svc",
    "cc-mail-relay",
    "cc-push-fanout",
    "cc-graph-index",
    "cc-batch-jobs",
    "cc-sheet-render",
    "cc-catalog-svc",
    "cc-blob-sweeper",
    "cc-rate-feed",
    "cc-privacy-svc",
    "cc-spider-farm",
    "cc-tile-bake",
    "cc-quota-svc",
]

WORDS = [
    "aurora",
    "basalt",
    "cinder",
    "dovetail",
    "ember",
    "fathom",
    "girder",
    "harrow",
    "indigo",
    "juniper",
    "kestrel",
    "lantern",
    "marlin",
    "nimbus",
    "onyx",
    "pewter",
    "quarry",
    "rivet",
    "sable",
    "tundra",
    "umber",
    "verdant",
    "willow",
    "yarrow",
    "zephyr",
    "amberly",
    "brindle",
    "coppice",
    "durban",
    "elmwood",
    "fernlea",
    "glenrow",
    "hollow",
    "ironvale",
    "jetstream",
    "kilnside",
    "larkspur",
    "mossgate",
    "northgate",
    "oakfield",
    "pinehurst",
    "quillon",
    "redbourne",
    "stonegate",
    "thornby",
    "upwell",
    "valeside",
    "westmoor",
    "yewtree",
    "zircon",
    "alderbrook",
    "bellfort",
    "cranleigh",
    "dunmore",
    "eastbury",
    "fallowfield",
    "garnock",
    "hazelden",
    "inglewood",
    "jarrowby",
    "kelvedon",
    "linsdale",
    "marchmont",
    "netherby",
    "oakhampton",
    "pendlebury",
    "quenby",
    "rushmere",
    "saltmarsh",
    "tarnwood",
    "ulverston",
    "vantwell",
    "wexcombe",
    "yardley",
    "zennor",
    "ashcombe",
    "birkdale",
    "chalfont",
    "denholme",
    "edgerton",
    "fenwick",
    "greystoke",
    "haverford",
    "islington",
    "jesmond",
    "kingsmere",
    "lyndhurst",
    "midhurst",
    "norbury",
    "ollerton",
    "pershore",
    "quarrydale",
    "rothbury",
    "swanscombe",
    "tewkesford",
    "uppingham",
    "vernham",
    "wolverton",
    "yatesbury",
    "zelwood",
]

INSTANCE_TYPES = ["t3.medium", "t3.large", "m5.large", "m5.xlarge", "m6i.large", "c6i.large", "r6i.large"]


class Stream:
    """A deterministic integer stream, seeded by a label so a change in one part
    of a document cannot shift the values in another."""

    def __init__(self, label: str) -> None:
        self.digest = hashlib.sha256(label.encode()).digest()
        self.position = 0

    def _byte(self) -> int:
        if self.position >= len(self.digest):
            self.digest = hashlib.sha256(self.digest).digest()
            self.position = 0
        value = self.digest[self.position]
        self.position += 1
        return value

    def below(self, bound: int) -> int:
        return self._byte() % bound

    def between(self, low: int, high: int) -> int:
        return low + self.below(high - low + 1)

    def hex(self, length: int) -> str:
        return "".join(f"{self._byte():02x}" for _ in range(length // 2 + 1))[:length]


class Builder:
    def __init__(self, spec: dict[str, Any]) -> None:
        self.spec = spec
        self.label = spec["label"]
        self.stream = Stream(f"{self.label}:attribution")
        self.word_position = spec["word_offset"]
        self.terminal_position = 0
        self.intermediate_position = 0
        self.terminal_codes = TERMINAL_CODES[spec["code_slice"][0] : spec["code_slice"][1]]
        self.intermediate_codes = INTERMEDIATE_CODES[spec["code_slice"][2] : spec["code_slice"][3]]

        self.pools: dict[str, dict[str, Any]] = {}
        self.units: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, str] = {}
        # (account_id, region, instance_id) -> tags
        self.nodes: dict[tuple[str, str, str], dict[str, str]] = {}
        self.chains: dict[str, dict[str, Any]] = {}
        self.node_slot = 0

        self.placements = [
            (account["account_id"], region)
            for account in spec["accounts"]
            for region in account["regions"]
        ]

    # -- naming ---------------------------------------------------------

    def word(self) -> str:
        value = WORDS[self.word_position % len(WORDS)]
        suffix = self.word_position // len(WORDS)
        self.word_position += 1
        return value if suffix == 0 else f"{value}-{suffix + 1}"

    def terminal_code(self) -> str:
        value = self.terminal_codes[self.terminal_position % len(self.terminal_codes)]
        self.terminal_position += 1
        return value

    def intermediate_code(self) -> str:
        value = self.intermediate_codes[self.intermediate_position % len(self.intermediate_codes)]
        self.intermediate_position += 1
        return value

    def next_placement(self) -> tuple[str, str]:
        placement = self.placements[self.node_slot % len(self.placements)]
        self.node_slot += 1
        return placement

    # -- chain construction ---------------------------------------------

    def add_chain(self, shape: dict[str, Any], ordinal: int) -> dict[str, Any]:
        chain_id = f"{shape['name']}-{ordinal}"
        records: list[dict[str, Any]] = []
        indirect: list[bool] = []
        pending_alias = False

        for step in shape["steps"]:
            if step == "alias":
                pending_alias = True
                continue
            name = self.word()
            if step == "pool":
                record = {"kind": "pool", "key": name, "ref": f"{POOL}{name}"}
            elif step == "unit":
                record = {"kind": "unit", "key": name, "ref": f"{UNIT}{name}"}
            elif step == "node":
                account_id, region = self.next_placement()
                instance_id = f"i-0{self.stream.hex(16)}"
                record = {
                    "kind": "node",
                    "key": (account_id, region, instance_id),
                    "ref": f"{NODE}{account_id}/{region}/{instance_id}",
                }
            else:
                raise ValueError(f"unknown step {step}")
            records.append(record)
            indirect.append(pending_alias)
            pending_alias = False

        chain = {
            "id": chain_id,
            "shape": shape["name"],
            "records": records,
            # True when the hand-off *into* record i goes through the parameter
            # tree. Index 0 is always False: a usage line names a pool outright.
            "indirect": indirect,
            "closing_indirect": pending_alias,
            "cycle_from": shape.get("cycle_from"),
            "join": shape.get("join"),
        }
        self.chains[chain_id] = chain
        return chain

    def assign_codes(self, chain: dict[str, Any]) -> None:
        records = chain["records"]
        cycle_from = chain["cycle_from"]
        if cycle_from is not None:
            shared = self.terminal_code()
            for index, record in enumerate(records):
                record["charge_code"] = shared if index >= cycle_from else self.intermediate_code()
            chain["expected"] = shared
        elif chain["join"] is not None:
            for record in records:
                record["charge_code"] = self.intermediate_code()
        else:
            for record in records[:-1]:
                record["charge_code"] = self.intermediate_code()
            records[-1]["charge_code"] = self.terminal_code()
            chain["expected"] = records[-1]["charge_code"]

    def link(self, chain: dict[str, Any], first_of_shape: dict[str, str]) -> None:
        records = chain["records"]
        for index in range(len(records) - 1):
            self.set_delegate(records[index], records[index + 1]["ref"], chain["indirect"][index + 1], chain, index)

        cycle_from = chain["cycle_from"]
        if cycle_from is not None:
            self.set_delegate(
                records[-1], records[cycle_from]["ref"], chain["closing_indirect"], chain, len(records) - 1
            )
        elif chain["join"] is not None:
            shape_name, offset = chain["join"]
            target = self.chains[first_of_shape[shape_name]]
            self.set_delegate(
                records[-1], target["records"][offset]["ref"], chain["closing_indirect"], chain, len(records) - 1
            )

    def set_delegate(
        self, record: dict[str, Any], target_ref: str, indirect: bool, chain: dict[str, Any], index: int
    ) -> None:
        if indirect:
            key = self.word()
            self.aliases[key] = target_ref
            record["delegate"] = f"{ALIAS}{key}"
        else:
            record["delegate"] = target_ref

    # -- materialisation -------------------------------------------------

    def materialise(self) -> None:
        for chain in self.chains.values():
            for record in chain["records"]:
                if record["kind"] == "pool":
                    entry: dict[str, Any] = {"chargeCode": record["charge_code"]}
                    if record.get("delegate"):
                        entry["rollsUpTo"] = record["delegate"]
                    self.pools[record["key"]] = entry
                elif record["kind"] == "unit":
                    entry = {"unitId": f"bu-{record['key']}", "chargeCode": record["charge_code"]}
                    if record.get("delegate"):
                        entry["parentRef"] = record["delegate"]
                    self.units[record["key"]] = entry
                else:
                    tags = {CHARGE_CODE_TAG: record["charge_code"]}
                    if record.get("delegate"):
                        tags[ROLLUP_TAG] = record["delegate"]
                    self.nodes[record["key"]] = tags

    # -- reference resolution --------------------------------------------

    def resolve(self, reference: str) -> str | None:
        """The charge code a reference finally lands on. Used to check the
        generator against itself; the scorer re-derives this independently."""
        seen: set[str] = set()
        pointer = reference
        code: str | None = None
        while pointer and pointer not in seen:
            seen.add(pointer)
            if pointer.startswith(ALIAS):
                pointer = self.aliases.get(pointer[len(ALIAS) :])
                continue
            record = self.record_for(pointer)
            if record is None:
                return code
            code = record.get("code") or code
            pointer = record.get("delegate")
        return code

    def record_for(self, reference: str) -> dict[str, Any] | None:
        if reference.startswith(POOL):
            entry = self.pools.get(reference[len(POOL) :])
            return None if entry is None else {"code": entry["chargeCode"], "delegate": entry.get("rollsUpTo")}
        if reference.startswith(UNIT):
            entry = self.units.get(reference[len(UNIT) :])
            return None if entry is None else {"code": entry["chargeCode"], "delegate": entry.get("parentRef")}
        if reference.startswith(NODE):
            parts = reference[len(NODE) :].split("/")
            if len(parts) != 3:
                return None
            tags = self.nodes.get((parts[0], parts[1], parts[2]))
            return None if tags is None else {"code": tags.get(CHARGE_CODE_TAG), "delegate": tags.get(ROLLUP_TAG)}
        return None

    def depth(self, reference: str) -> int:
        """How many records a walk visits before it can stop."""
        seen: set[str] = set()
        pointer = reference
        visited = 0
        while pointer and pointer not in seen:
            seen.add(pointer)
            if pointer.startswith(ALIAS):
                pointer = self.aliases.get(pointer[len(ALIAS) :])
                continue
            record = self.record_for(pointer)
            if record is None:
                break
            visited += 1
            pointer = record.get("delegate")
        return visited


def build(spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    builder = Builder(spec)

    ordered_chains: list[dict[str, Any]] = []
    first_of_shape: dict[str, str] = {}
    for shape in SHAPES:
        for ordinal in range(spec["chains"][shape["name"]]):
            chain = builder.add_chain(shape, ordinal + 1)
            first_of_shape.setdefault(shape["name"], chain["id"])
            ordered_chains.append(chain)
    for chain in ordered_chains:
        builder.assign_codes(chain)
    for chain in ordered_chains:
        builder.link(chain, first_of_shape)
    builder.materialise()

    # -- usage lines ----------------------------------------------------

    accounts = spec["accounts"]
    lines_by_account: dict[str, list[dict[str, Any]]] = {a["account_id"]: [] for a in accounts}
    expected_totals: dict[str, dict[str, float]] = {}
    depths: dict[int, int] = {}
    line_stream = Stream(f"{spec['label']}:lines")
    slot = 0

    for chain in ordered_chains:
        head = chain["records"][0]["ref"]
        code = builder.resolve(head)
        depth = builder.depth(head)
        for _ in range(spec["lines_per_chain"][chain["shape"]]):
            account = accounts[slot % len(accounts)]
            region = account["regions"][slot % len(account["regions"])]
            slot += 1
            quantity = float(line_stream.between(20, 900))
            amount = round(quantity * (line_stream.between(150, 4800) / 1000.0), 2)
            lines_by_account[account["account_id"]].append(
                {
                    "lineId": f"ln-{line_stream.hex(12)}",
                    "resourceId": f"i-0{line_stream.hex(16)}",
                    "region": region,
                    "quantity": quantity,
                    "amount": amount,
                    "attribution": head,
                }
            )
            running = expected_totals.setdefault(code, {"quantity": 0.0, "amount": 0.0, "lineCount": 0})
            running["quantity"] += quantity
            running["amount"] += amount
            running["lineCount"] += 1
            depths[depth] = depths.get(depth, 0) + 1

    # -- documents ------------------------------------------------------

    hub_id = spec["hub_account"]
    metering_bucket = spec["bucket"]
    registry_key = "onboarding/registry.json"
    attribution_prefix = "attribution/"
    usage_prefix = "usage/"

    registry_accounts = []
    metered_accounts = []
    export_objects = 0
    export_list_pages = 0

    for account in accounts:
        account_id = account["account_id"]
        registry_accounts.append(
            {
                "accountId": account_id,
                "roleArn": f"arn:aws:iam::{account_id}:role/metering-metering",
                "externalId": account["external_id"],
                "region": account["regions"][0],
                "usageBucket": account["usage_bucket"],
            }
        )

        lines = lines_by_account[account_id]
        batch_size = spec["export_batch_size"]
        batches = [lines[i : i + batch_size] for i in range(0, len(lines), batch_size)]
        objects = []
        batch_stream = Stream(f"{spec['label']}:{account_id}:exports")
        for number, batch in enumerate(batches, start=1):
            month = ((number - 1) % 12) + 1
            day = ((number - 1) % 27) + 1
            key = f"{usage_prefix}{account_id}/2026-{month:02d}-{day:02d}-sweep-{batch_stream.hex(8)}.json"
            objects.append(
                {
                    "key": key,
                    "last_modified": f"2026-{month:02d}-{day:02d}T05:00:00Z",
                    "body_json": {
                        "batchId": key.rsplit("/", 1)[-1].removesuffix(".json"),
                        "coveringDate": f"2026-{month:02d}-{day:02d}",
                        "lines": batch,
                    },
                }
            )
        export_objects += len(objects)
        export_list_pages += max(1, math.ceil(len(objects) / spec["export_page_size"]))

        instances = []
        decoy_stream = Stream(f"{spec['label']}:{account_id}:decoys")
        for (node_account, region, instance_id), tags in sorted(builder.nodes.items()):
            if node_account != account_id:
                continue
            instances.append(
                {
                    "instance_id": instance_id,
                    "instance_type": INSTANCE_TYPES[decoy_stream.below(len(INSTANCE_TYPES))],
                    "region": region,
                    "availability_zone": f"{region}{'abc'[decoy_stream.below(3)]}",
                    "state": "running",
                    "tags": {"Name": f"{account['alias']}-{instance_id[-6:]}", **tags},
                }
            )
        for region in account["regions"]:
            for _ in range(spec["decoy_instances_per_region"]):
                instance_id = f"i-0{decoy_stream.hex(16)}"
                instances.append(
                    {
                        "instance_id": instance_id,
                        "instance_type": INSTANCE_TYPES[decoy_stream.below(len(INSTANCE_TYPES))],
                        "region": region,
                        "availability_zone": f"{region}{'abc'[decoy_stream.below(3)]}",
                        "state": "running",
                        "tags": {"Name": f"{account['alias']}-{instance_id[-6:]}"},
                    }
                )

        metered_accounts.append(
            {
                "account_id": account_id,
                "alias": account["alias"],
                "roles": [
                    {
                        "name": "metering-metering",
                        "trust_policy": {
                            "Version": "2012-10-17",
                            "Statement": [
                                {
                                    "Effect": "Allow",
                                    "Action": "sts:AssumeRole",
                                    "Principal": {"AWS": f"arn:aws:iam::{hub_id}:root"},
                                    "Condition": {"StringEquals": {"sts:ExternalId": account["external_id"]}},
                                }
                            ],
                        },
                    }
                ],
                "regions": [{"name": region} for region in account["regions"]],
                "instances": instances,
                "buckets": [
                    {
                        "name": account["usage_bucket"],
                        "region": account["regions"][0],
                        "objects": objects,
                    }
                ],
            }
        )

    registry = {
        "businessID": spec["business"],
        "usageExportPrefix": usage_prefix,
        "attributionPrefix": attribution_prefix,
        "accounts": registry_accounts,
    }

    metering_objects = [
        {
            "key": registry_key,
            "last_modified": "2026-01-04T08:00:00Z",
            "body_json": registry,
        },
        {
            "key": f"{attribution_prefix}pools.json",
            "last_modified": "2026-01-09T08:00:00Z",
            "body_json": {
                "revision": spec["pools_revision"],
                "pools": {name: builder.pools[name] for name in sorted(builder.pools)},
            },
        },
    ]
    for name in sorted(builder.units):
        metering_objects.append(
            {
                "key": f"{attribution_prefix}units/{name}.json",
                "last_modified": "2026-01-09T08:00:00Z",
                "body_json": builder.units[name],
            }
        )

    scenario = {
        "region": "us-east-1",
        "bootstrap_identity": {"account_id": hub_id, "access_key_id": spec["access_key_id"]},
        "accounts": [
            {
                "account_id": hub_id,
                "alias": spec["hub_alias"],
                "buckets": [{"name": metering_bucket, "region": "us-east-1", "objects": metering_objects}],
                "parameters": {
                    f"{ALIAS_PARAMETER_ROOT}{key}": builder.aliases[key] for key in sorted(builder.aliases)
                },
            },
            *metered_accounts,
        ],
        "faults": {
            "enabled": True,
            "rules": [
                {"service": "s3", "action": "ListObjectsV2", "max_page_size": spec["export_page_size"]},
                {
                    "service": "ec2",
                    "action": "DescribeInstances",
                    "throttle_every": spec["throttle_every"],
                    "throttle_burst": 2,
                },
            ],
        },
    }

    expected = {
        code: {
            "quantity": round(values["quantity"], 10),
            "amount": round(values["amount"], 10),
            "lineCount": values["lineCount"],
        }
        for code, values in sorted(expected_totals.items())
    }

    scale = {
        "label": spec["label"],
        "business": spec["business"],
        "metering_bucket": metering_bucket,
        "registry_key": registry_key,
        "accounts": len(accounts),
        "regions": sorted({region for account in accounts for region in account["regions"]}),
        "chains": len(ordered_chains),
        "usage_lines": sum(len(rows) for rows in lines_by_account.values()),
        "export_objects": export_objects,
        "pools": len(builder.pools),
        "unit_objects": len(builder.units),
        "alias_parameters": len(builder.aliases),
        "node_instances": len(builder.nodes),
        "charge_codes": len(expected),
        "depth_histogram": {str(depth): count for depth, count in sorted(depths.items())},
        "shapes": {shape["name"]: spec["chains"][shape["name"]] for shape in SHAPES},
        "calls": {
            "s3_get_registry": 1,
            "s3_get_pools": 1,
            "sts_assume_role": len(accounts),
            "s3_list_exports": export_list_pages,
            "s3_get_export": export_objects,
            "s3_get_unit": len(builder.units),
            "ssm_get_parameter": len(builder.aliases),
            "ec2_describe_instances": len(builder.nodes),
        },
    }
    scale["calls"]["total"] = sum(scale["calls"].values())

    structures = {
        "reference_kinds": sorted(
            {
                kind
                for chain in ordered_chains
                for record in chain["records"]
                for kind in [record["kind"]]
            }
        ),
        "indirect_hops": any(
            any(chain["indirect"]) or chain["closing_indirect"] for chain in ordered_chains
        ),
        "shapes_used": sorted({chain["shape"] for chain in ordered_chains}),
        "max_depth": max(depths),
        "cycle_shapes": sorted({chain["shape"] for chain in ordered_chains if chain["cycle_from"] is not None}),
        "join_shapes": sorted({chain["shape"] for chain in ordered_chains if chain["join"] is not None}),
        "record_fields": sorted(
            {"chargeCode", "rollsUpTo", "unitId", "parentRef", CHARGE_CODE_TAG, ROLLUP_TAG}
        ),
    }

    return scenario, {"scale": scale, "expected": expected, "structures": structures}


def counts(**overrides: int) -> dict[str, int]:
    table = {shape["name"]: 0 for shape in SHAPES}
    table.update(overrides)
    missing = [name for name, value in table.items() if value <= 0]
    if missing:
        raise ValueError(f"every shape must appear at least once, missing {missing}")
    return table


SANDBOX = {
    "label": "sandbox",
    "business": "biz-loomwright",
    "hub_account": "800000000027",
    "hub_alias": "loomwright-metering",
    "bucket": "metering-metering-loomwright",
    "access_key_id": "AKIAMETERINGATTRIB01",
    "pools_revision": "2026-01-09.3",
    "word_offset": 0,
    "code_slice": (0, 16, 0, 18),
    "export_batch_size": 4,
    "export_page_size": 2,
    "throttle_every": 9,
    "decoy_instances_per_region": 2,
    "chains": counts(
        **{
            "direct": 3,
            "unit-1": 2,
            "node-1": 2,
            "alias-unit": 1,
            "unit-node": 1,
            "node-unit": 1,
            "unit-alias-node": 1,
            "four": 1,
            "five": 1,
            "six": 1,
            "loop-short": 1,
            "loop-long": 1,
            "join-deep": 1,
            "join-mid": 1,
        }
    ),
    "lines_per_chain": {
        "direct": 3,
        "unit-1": 2,
        "node-1": 2,
        "alias-unit": 2,
        "unit-node": 2,
        "node-unit": 2,
        "unit-alias-node": 2,
        "four": 2,
        "five": 1,
        "six": 1,
        "loop-short": 1,
        "loop-long": 1,
        "join-deep": 1,
        "join-mid": 1,
    },
    "accounts": [
        {
            "account_id": "310000000012",
            "alias": "loomwright-platform",
            "external_id": "loomwright-a1-3d92",
            "usage_bucket": "metering-usage-loomwright-platform",
            "regions": ["us-east-1", "eu-west-1"],
        },
        {
            "account_id": "310000000028",
            "alias": "loomwright-analytics",
            "external_id": "loomwright-a2-7c41",
            "usage_bucket": "metering-usage-loomwright-analytics",
            "regions": ["us-east-1", "ap-southeast-1"],
        },
    ],
}

HOLDOUT = {
    "label": "holdout",
    "business": "biz-tessellate",
    "hub_account": "700000000031",
    "hub_alias": "tessellate-metering",
    "bucket": "metering-metering-tessellate",
    "access_key_id": "AKIAMETERINGATTRIB01",
    "pools_revision": "2026-02-11.7",
    "word_offset": 50,
    "code_slice": (16, 40, 18, 38),
    "export_batch_size": 5,
    "export_page_size": 3,
    "throttle_every": 11,
    "decoy_instances_per_region": 3,
    "chains": counts(
        **{
            "direct": 7,
            "unit-1": 5,
            "node-1": 4,
            "alias-unit": 3,
            "unit-node": 3,
            "node-unit": 2,
            "unit-alias-node": 2,
            "four": 2,
            "five": 1,
            "six": 1,
            "loop-short": 1,
            "loop-long": 1,
            "join-deep": 1,
            "join-mid": 1,
        }
    ),
    "lines_per_chain": {
        "direct": 4,
        "unit-1": 3,
        "node-1": 3,
        "alias-unit": 3,
        "unit-node": 2,
        "node-unit": 2,
        "unit-alias-node": 2,
        "four": 2,
        "five": 2,
        "six": 2,
        "loop-short": 2,
        "loop-long": 2,
        "join-deep": 1,
        "join-mid": 2,
    },
    "accounts": [
        {
            "account_id": "210000000031",
            "alias": "tessellate-platform",
            "external_id": "tessellate-a1-4f21",
            "usage_bucket": "metering-usage-tessellate-platform",
            "regions": ["us-east-2", "eu-central-1"],
        },
        {
            "account_id": "210000000047",
            "alias": "tessellate-ingest",
            "external_id": "tessellate-a2-9b07",
            "usage_bucket": "metering-usage-tessellate-ingest",
            "regions": ["us-east-2", "ap-northeast-1"],
        },
        {
            "account_id": "210000000053",
            "alias": "tessellate-serving",
            "external_id": "tessellate-a3-1d68",
            "usage_bucket": "metering-usage-tessellate-serving",
            "regions": ["us-west-2", "eu-west-1"],
        },
        {
            "account_id": "210000000061",
            "alias": "tessellate-research",
            "external_id": "tessellate-a4-5e30",
            "usage_bucket": "metering-usage-tessellate-research",
            "regions": ["us-west-2", "ca-central-1"],
        },
    ],
}


def report(meta: dict[str, Any]) -> None:
    scale = meta["scale"]
    print(
        f"{scale['label']}: {scale['usage_lines']} usage lines over {scale['chains']} chains, "
        f"{scale['accounts']} accounts, {len(scale['regions'])} regions, "
        f"{scale['charge_codes']} charge codes, {scale['calls']['total']} minimum API calls"
    )
    print(f"    stores: {scale['pools']} pools, {scale['unit_objects']} unit objects, "
          f"{scale['alias_parameters']} aliases, {scale['node_instances']} tagged instances")
    print(f"    depth histogram (lines by chain depth): {json.dumps(scale['depth_histogram'])}")
    print(f"    calls: {json.dumps(scale['calls'])}")


def check(sandbox_meta: dict[str, Any], holdout_meta: dict[str, Any]) -> None:
    """Every structure the held-out document uses must appear in the sandbox."""
    left, right = sandbox_meta["structures"], holdout_meta["structures"]
    problems: list[str] = []

    for field in ("reference_kinds", "shapes_used", "cycle_shapes", "join_shapes", "record_fields"):
        missing = sorted(set(right[field]) - set(left[field]))
        if missing:
            problems.append(f"{field}: held out but absent from the sandbox: {missing}")
    if right["indirect_hops"] and not left["indirect_hops"]:
        problems.append("indirect alias hops appear only in the held-out document")
    if right["max_depth"] > left["max_depth"]:
        problems.append(
            f"deepest held-out chain is {right['max_depth']} records, "
            f"deepest sandbox chain is only {left['max_depth']}"
        )

    sandbox_codes = set(sandbox_meta["expected"])
    holdout_codes = set(holdout_meta["expected"])
    if sandbox_codes & holdout_codes:
        # Shared answer values are not unfair, but they make a sandbox result
        # look like a held-out one, so flag them.
        print(f"note: {len(sandbox_codes & holdout_codes)} charge codes appear in both documents")

    if problems:
        for line in problems:
            print(f"FAIL {line}")
        raise SystemExit(1)
    print("structural check: every reference kind, record field, chain shape, cycle, join and depth")
    print(f"                  held out is also exercised by the sandbox (max depth {left['max_depth']})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent))
    parser.add_argument("--check", action="store_true", help="only run the sandbox/holdout structural check")
    args = parser.parse_args()
    root = Path(args.out)

    sandbox, sandbox_meta = build(SANDBOX)
    holdout, holdout_meta = build(HOLDOUT)

    check(sandbox_meta, holdout_meta)
    if args.check:
        report(sandbox_meta)
        report(holdout_meta)
        return

    (root / "sandbox").mkdir(parents=True, exist_ok=True)
    (root / "verifier-data").mkdir(parents=True, exist_ok=True)
    (root / "sandbox" / "public.json").write_text(json.dumps(sandbox, indent=1) + "\n")
    (root / "verifier-data" / "holdout.json").write_text(json.dumps(holdout, indent=1) + "\n")

    run_spec = {
        "runs": [
            {
                "label": "estate",
                "businessID": HOLDOUT["business"],
                "registryBucket": HOLDOUT["bucket"],
                "registryKey": "onboarding/registry.json",
            }
        ]
    }
    (root / "verifier-data" / "run-spec.json").write_text(json.dumps(run_spec, indent=2) + "\n")

    (root.parent / "scale.json").write_text(
        json.dumps({"sandbox": sandbox_meta["scale"], "holdout": holdout_meta["scale"]}, indent=2) + "\n"
    )

    report(sandbox_meta)
    report(holdout_meta)


if __name__ == "__main__":
    main()
