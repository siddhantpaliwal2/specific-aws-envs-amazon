#!/usr/bin/env python3
"""Validate and summarize the report's Opus 5 trajectories for Tasks 1-4."""

from __future__ import annotations

import json
from collections import defaultdict
from math import comb
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RAW_ROOT = Path("sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818")
INDEX_PATH = ROOT / "sample-run/indexes/report-opus5-trials.json"
MANIFEST_PATH = ROOT / "sample-run/manifests/report-opus5-results.json"
MATRIX_PATH = ROOT / "sample-run/indexes/report-opus5-pass-rate-matrix.md"
SOURCE_COMMIT = "cae33b207f8104b04aa3f9ed1a46cc0526c79b5a"
SOURCE_TRAJECTORY_ROOT = "sample-run/trajectories"
MODEL = "bedrock/us.anthropic.claude-opus-5"
MODEL_LABEL = "Opus 5"

TASKS = (
    "01-tenant-attribution",
    "02-entitlement-overage-lines",
    "03-usage-window-aggregation",
    "04-usage-attribution-chain",
)
TASK_LABELS = {
    "01-tenant-attribution": "Task 1 — tenant attribution",
    "02-entitlement-overage-lines": "Task 2 — entitlement overage lines",
    "03-usage-window-aggregation": "Task 3 — usage-window aggregation",
    "04-usage-attribution-chain": "Task 4 — usage attribution chain",
}
TRIALS_BY_TASK = {
    "01-tenant-attribution": (
        "01-tenant-attribution__2T5UzXB",
        "01-tenant-attribution__4co4RCR",
        "01-tenant-attribution__EHfBTeo",
        "01-tenant-attribution__GhSBik5",
        "01-tenant-attribution__HunCTf8",
        "01-tenant-attribution__PCUSiDa",
        "01-tenant-attribution__ZTfDyG2",
        "01-tenant-attribution__qKxmRmP",
    ),
    "02-entitlement-overage-lines": (
        "02-entitlement-overage-lines__4GSa6G2",
        "02-entitlement-overage-lines__5KnoWGk",
        "02-entitlement-overage-lines__NtzUVfh",
        "02-entitlement-overage-lines__aPCTfwP",
        "02-entitlement-overage-lines__de2weXF",
        "02-entitlement-overage-lines__ru72p2d",
        "02-entitlement-overage-lines__tgnLTEf",
        "02-entitlement-overage-lines__vc9j3L7",
    ),
    "03-usage-window-aggregation": (
        "03-usage-window-aggregation__GLawX4w",
        "03-usage-window-aggregation__YVa8rqM",
        "03-usage-window-aggregation__jVoti64",
        "03-usage-window-aggregation__m7eZorM",
        "03-usage-window-aggregation__pQLuJEo",
        "03-usage-window-aggregation__ppvEmdZ",
        "03-usage-window-aggregation__sYFMDLh",
        "03-usage-window-aggregation__wkiTvtP",
    ),
    "04-usage-attribution-chain": (
        "04-usage-attribution-chain__TafFjzR",
        "04-usage-attribution-chain__UXrhGXu",
        "04-usage-attribution-chain__X8xAW2T",
        "04-usage-attribution-chain__b4oeGGM",
        "04-usage-attribution-chain__cfjSCuA",
        "04-usage-attribution-chain__ijEh492",
        "04-usage-attribution-chain__pvP8RbL",
        "04-usage-attribution-chain__tUgr2qi",
    ),
}
EXPECTED_IDENTITIES = {
    "01-tenant-attribution": {
        "task_digest": "sha256:f67f6c0eca0ac1902755e656feee5d72f2f23cba0f6c6cc96e729dc6eaaacc7f",
        "result_task_checksum": "280280408fa77838067f7cad26b933acbc7b292bece1f3d8998c0a7cc0426440",
    },
    "02-entitlement-overage-lines": {
        "task_digest": "sha256:2cc4128ccb2c2c16dbd03add70c8fac2b273d15f17dc6062ed67b012b6cd67ec",
        "result_task_checksum": "5a6d23e8a1782f287f2618293ff507bd78026a03d7916c90092cb03d7343bb55",
    },
    "03-usage-window-aggregation": {
        "task_digest": "sha256:4f7323caab802b01e8878f0a10d27fa77ab5c55be71bb13760ef0103ff00d312",
        "result_task_checksum": "9c2581bf8e627161cab32db43d2851a24d2c738464ed49c2409103282beb00d4",
    },
    "04-usage-attribution-chain": {
        "task_digest": "sha256:c6b8c422bd0cb03051d6725863ca888bc03ca255f3c49cfd6d2512cee1dc544f",
        "result_task_checksum": "73eb591b0b8d83c351e363fc504d25f00728971e8b41028299aa83955959b88c",
    },
}
ARTIFACTS = {
    "result": "result.json",
    "lock": "lock.json",
    "trajectory": "agent/trajectory.json",
    "native_trajectory": "agent/mini-swe-agent.trajectory.json",
    "transcript": "agent/mini-swe-agent.txt",
    "verifier_reward": "verifier/reward.json",
    "verifier_report": "verifier/report.txt",
    "verifier_stdout": "verifier/test-stdout.txt",
}


def load_json(path: Path):
    return json.loads(path.read_text())


def pass_at_k(n: int, c: int, k: int) -> float:
    if c == 0:
        return 0.0
    if n - c < k:
        return 1.0
    return 1.0 - comb(n - c, k) / comb(n, k)


def build_trials() -> list[dict]:
    trials = []
    for task in TASKS:
        for attempt, trial_name in enumerate(TRIALS_BY_TASK[task], start=1):
            trial_dir = RAW_ROOT / trial_name
            absolute_trial_dir = ROOT / trial_dir
            missing = [
                relative_path
                for relative_path in ARTIFACTS.values()
                if not (absolute_trial_dir / relative_path).is_file()
            ]
            if missing:
                raise SystemExit(f"missing artifacts for {trial_name}: {missing}")

            result = load_json(absolute_trial_dir / ARTIFACTS["result"])
            lock = load_json(absolute_trial_dir / ARTIFACTS["lock"])
            verifier_reward = load_json(
                absolute_trial_dir / ARTIFACTS["verifier_reward"]
            )["reward"]
            result_reward = result["verifier_result"]["rewards"]["reward"]
            task_digest = lock["task"]["digest"]
            task_checksum = result["task_checksum"]
            expected = EXPECTED_IDENTITIES[task]

            if result.get("trial_name") != trial_name:
                raise SystemExit(f"trial-name mismatch for {trial_name}")
            if result["config"]["agent"]["model_name"] != MODEL:
                raise SystemExit(f"model mismatch for {trial_name}")
            if result.get("exception_info") is not None:
                raise SystemExit(f"Harbor exception in {trial_name}")
            if verifier_reward != result_reward:
                raise SystemExit(f"reward mismatch for {trial_name}")
            if not isinstance(verifier_reward, (int, float)):
                raise SystemExit(f"non-numeric reward for {trial_name}")
            if (
                task_digest != expected["task_digest"]
                or task_checksum != expected["result_task_checksum"]
            ):
                raise SystemExit(f"frozen-identity mismatch for {trial_name}")

            source_trial_dir = (
                f"{SOURCE_TRAJECTORY_ROOT}/{task}/opus-5/trial-{attempt:02d}"
            )
            item = {
                "trial": trial_name,
                "task": task,
                "task_label": TASK_LABELS[task],
                "model": MODEL,
                "model_label": MODEL_LABEL,
                "reward": verifier_reward,
                "passed": bool(verifier_reward),
                "valid": True,
                "exception_info": None,
                "task_digest": task_digest,
                "result_task_checksum": task_checksum,
                "trial_dir": trial_dir.as_posix(),
                "report_source_trial_dir": source_trial_dir,
                "source_commit": SOURCE_COMMIT,
                "input_tokens": result["agent_result"]["n_input_tokens"],
                "cache_tokens": result["agent_result"]["n_cache_tokens"],
                "output_tokens": result["agent_result"]["n_output_tokens"],
                "reported_cost_usd": result["agent_result"]["cost_usd"],
                "final_provenance": "report-opus5-source-cohort",
                "attempt": attempt,
            }
            for key, relative_path in ARTIFACTS.items():
                item[key] = (trial_dir / relative_path).as_posix()
            trials.append(item)
    if len(trials) != 32:
        raise SystemExit(f"expected 32 imported Opus 5 trials, found {len(trials)}")
    return trials


def build_cells(trials: list[dict]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for trial in trials:
        grouped[trial["task"]].append(trial)

    cells = []
    for task in TASKS:
        cell = grouped[task]
        if len(cell) != 8:
            raise SystemExit(f"expected eight Opus 5 trials for {task}")
        n = len(cell)
        c = sum(item["passed"] for item in cell)
        cells.append(
            {
                "task": task,
                "task_label": TASK_LABELS[task],
                "model": MODEL,
                "model_label": MODEL_LABEL,
                "solves": c,
                "attempts": n,
                "observed_pass_rate": c / n,
                "pass_at_1": pass_at_k(n, c, 1),
                "pass_at_3": pass_at_k(n, c, 3),
                "pass_at_8": pass_at_k(n, c, 8),
                **EXPECTED_IDENTITIES[task],
                "reported_cost_usd": sum(
                    item["reported_cost_usd"] for item in cell
                ),
            }
        )
    return cells


def write_matrix(cells: list[dict], total_solves: int) -> None:
    lines = [
        "# Opus 5 report trajectories for Tasks 1–4",
        "",
        "All 32 report-referenced Opus 5 trials are valid and have complete",
        "trajectory and verifier artifacts.",
        "",
        "These rows retain the report cohort's frozen task identities. They are",
        "not pooled with the earlier Opus 4.8 cohort stored at the same stable raw root.",
        "",
        "| Task | Model | Solves | Observed pass rate | pass@1 | pass@3 | pass@8 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for cell in cells:
        lines.append(
            f"| {cell['task_label']} | {MODEL_LABEL} | "
            f"{cell['solves']}/{cell['attempts']} | "
            f"{cell['observed_pass_rate']:.1%} | {cell['pass_at_1']:.4f} | "
            f"{cell['pass_at_3']:.4f} | {cell['pass_at_8']:.4f} |"
        )
    lines.extend(
        [
            "",
            "## Model total",
            "",
            "| Model | Solves | Observed pass rate |",
            "| --- | ---: | ---: |",
            f"| {MODEL_LABEL} | {total_solves}/32 | {total_solves / 32:.2%} |",
            "",
            "The observed pass rate is the raw solve fraction. `pass@k` uses",
            "`1 - C(n-c, k) / C(n, k)`.",
            "",
        ]
    )
    MATRIX_PATH.write_text("\n".join(lines))


def main() -> None:
    trials = build_trials()
    cells = build_cells(trials)
    total_solves = sum(item["passed"] for item in trials)

    INDEX_PATH.write_text(json.dumps(trials, indent=2) + "\n")
    write_matrix(cells, total_solves)
    MANIFEST_PATH.write_text(
        json.dumps(
            {
                "tasks": list(TASKS),
                "models": [MODEL],
                "validTrials": len(trials),
                "excludedTrials": 0,
                "attemptsPerTaskModelCell": 8,
                "trajectoryRoot": RAW_ROOT.as_posix(),
                "sourceCommit": SOURCE_COMMIT,
                "sourceTrajectoryRoot": SOURCE_TRAJECTORY_ROOT,
                "artifactTransformations": {
                    "layout": "copied into the existing stable raw-evidence folder under original Harbor trial names",
                    "metadata": "no artifact content changed",
                    "preserved": "all trajectory, transcript, result, lock, reward, report, and verifier-stdout bytes",
                },
                "reportLinkPolicy": (
                    "report_source_trial_dir maps every PDF trajectory path to the "
                    "corresponding imported raw trial"
                ),
                "comparisonPolicy": (
                    "The imported Opus 5 cells retain the source report's frozen task "
                    "identities and are not pooled with the earlier Opus 4.8 cohort, "
                    "whose recorded digests and run policy differ."
                ),
                "cells": cells,
                "modelTotals": [
                    {
                        "model": MODEL,
                        "model_label": MODEL_LABEL,
                        "solves": total_solves,
                        "attempts": len(trials),
                        "observed_pass_rate": total_solves / len(trials),
                    }
                ],
                "sourceControls": {
                    task: {
                        "valid": True,
                        "task_digest": EXPECTED_IDENTITIES[task]["task_digest"],
                        "oracle": 1.0,
                        "nop": 0.0,
                    }
                    for task in TASKS
                },
                "denominatorPolicy": (
                    "numeric verifier reward; complete normalized and native trajectory, "
                    "transcript, result, lock, and verifier artifacts; one frozen task "
                    "digest and result checksum per cell; no Harbor exception"
                ),
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"indexed={len(trials)} cells={len(cells)} missing=0 "
        f"total={(MODEL_LABEL, total_solves)}"
    )


if __name__ == "__main__":
    main()
