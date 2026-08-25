#!/usr/bin/env python3
"""Validate and summarize the additive Task 14 raw cohort."""

from __future__ import annotations

import json
from collections import defaultdict
from math import comb
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INDEX_PATH = ROOT / "sample-run/indexes/task14-trials.json"
MANIFEST_PATH = ROOT / "sample-run/manifests/task14-results.json"
MATRIX_PATH = ROOT / "sample-run/indexes/task14-pass-rate-matrix.md"
RAW_ROOT = Path("sample-run/raw/amazon-task14-two-opus-cohort-20260824")
TASKS = (
    "14-iam-role-validation",
)
TASK_LABELS = {
    "14-iam-role-validation": "Task 14 — IAM-role validation",
}
MODELS = (
    "bedrock/us.anthropic.claude-opus-4-8",
    "bedrock/us.anthropic.claude-opus-5",
)
MODEL_LABELS = {
    MODELS[0]: "Opus 4.8",
    MODELS[1]: "Opus 5",
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


def pass_at_k(n: int, c: int, k: int) -> float:
    if c == 0:
        return 0.0
    if n - c < k:
        return 1.0
    return 1.0 - comb(n - c, k) / comb(n, k)


def load_json(path: Path):
    return json.loads(path.read_text())


def canonicalize_paths(source_trials: list[dict]) -> list[dict]:
    trials: list[dict] = []
    for source in source_trials:
        if source.get("task") not in TASKS:
            continue
        item = dict(source)
        trial_dir = RAW_ROOT / item["trial"]
        item["task_label"] = TASK_LABELS[item["task"]]
        item["model_label"] = MODEL_LABELS[item["model"]]
        item["final_provenance"] = "matched-task14-source-cohort"
        item["trial_dir"] = trial_dir.as_posix()
        for key, relative_path in ARTIFACTS.items():
            item[key] = (trial_dir / relative_path).as_posix()
        trials.append(item)
    return sorted(trials, key=lambda item: (item["model"], item["attempt"]))


def validate_trials(trials: list[dict]) -> dict[tuple[str, str], list[dict]]:
    if len(trials) != 16:
        raise SystemExit(f"expected 16 Task 14 trials, found {len(trials)}")

    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    missing = []
    for trial in trials:
        if not trial.get("valid") or trial.get("exception_info") is not None:
            raise SystemExit(f"invalid final trial: {trial['trial']}")
        grouped[(trial["task"], trial["model"])].append(trial)
        for key in ARTIFACTS:
            path = ROOT / trial[key]
            if not path.is_file():
                missing.append((trial["trial"], key, trial[key]))
        reward_path = ROOT / trial["verifier_reward"]
        result_path = ROOT / trial["result"]
        if reward_path.is_file() and result_path.is_file():
            reward = load_json(reward_path)["reward"]
            result = load_json(result_path)
            if result.get("trial_name") != trial["trial"]:
                raise SystemExit(
                    f"trial-name mismatch for {trial['trial']}: "
                    f"result={result.get('trial_name')}"
                )
            if result["config"]["agent"]["model_name"] != trial["model"]:
                raise SystemExit(f"model mismatch for {trial['trial']}")
            result_reward = result["verifier_result"]["rewards"]["reward"]
            if reward != result_reward or bool(reward) != bool(trial["passed"]):
                raise SystemExit(
                    f"reward mismatch for {trial['trial']}: "
                    f"index={trial['passed']} reward={reward} result={result_reward}"
                )
    if missing:
        raise SystemExit(f"missing final artifacts: {missing}")

    expected = {(task, model) for task in TASKS for model in MODELS}
    if set(grouped) != expected or any(len(cell) != 8 for cell in grouped.values()):
        raise SystemExit(
            "expected eight Task 14 trials in every model cell: "
            + repr({key: len(value) for key, value in grouped.items()})
        )
    return grouped


def build_cells(grouped: dict[tuple[str, str], list[dict]]) -> list[dict]:
    cells = []
    for task in TASKS:
        for model in MODELS:
            cell = grouped[(task, model)]
            digests = {item["task_digest"] for item in cell}
            checksums = {item["result_task_checksum"] for item in cell}
            if len(digests) != 1 or len(checksums) != 1:
                raise SystemExit(
                    f"mixed frozen identity for {task}/{model}: "
                    f"digests={digests} checksums={checksums}"
                )
            n = len(cell)
            c = sum(item["passed"] for item in cell)
            cells.append(
                {
                    "task": task,
                    "task_label": TASK_LABELS[task],
                    "model": model,
                    "model_label": MODEL_LABELS[model],
                    "solves": c,
                    "attempts": n,
                    "observed_pass_rate": c / n,
                    "pass_at_1": pass_at_k(n, c, 1),
                    "pass_at_3": pass_at_k(n, c, 3),
                    "pass_at_8": pass_at_k(n, c, 8),
                    "task_digest": digests.pop(),
                    "result_task_checksum": checksums.pop(),
                    "reported_cost_usd": sum(item["reported_cost_usd"] for item in cell),
                }
            )
    return cells


def validate_controls(cells: list[dict], controls: dict) -> None:
    for task in TASKS:
        digests = {cell["task_digest"] for cell in cells if cell["task"] == task}
        control = controls.get(task, {})
        if (
            len(digests) != 1
            or control.get("task_digest") != next(iter(digests))
            or control.get("oracle") != 1.0
            or control.get("nop") != 0.0
            or not control.get("valid")
        ):
            raise SystemExit(f"control gate failed for {task}: {control}")


def main() -> None:
    source_trials = load_json(INDEX_PATH)
    existing_manifest = load_json(MANIFEST_PATH)
    trials = canonicalize_paths(source_trials)
    grouped = validate_trials(trials)
    cells = build_cells(grouped)
    controls = {
        task: {
            "valid": existing_manifest["controls"][task]["valid"],
            "task_digest": existing_manifest["controls"][task]["task_digest"],
            "oracle": existing_manifest["controls"][task]["oracle"],
            "nop": existing_manifest["controls"][task]["nop"],
        }
        for task in TASKS
    }
    validate_controls(cells, controls)

    model_totals = []
    for model in MODELS:
        model_trials = [trial for trial in trials if trial["model"] == model]
        solves = sum(trial["passed"] for trial in model_trials)
        model_totals.append(
            {
                "model": model,
                "model_label": MODEL_LABELS[model],
                "solves": solves,
                "attempts": len(model_trials),
                "observed_pass_rate": solves / len(model_trials),
            }
        )

    INDEX_PATH.write_text(json.dumps(trials, indent=2) + "\n")
    lines = [
        "# Task 14 two-Opus results",
        "",
        "All 16 Task 14 trials are valid and have complete trajectory and verifier artifacts.",
        "",
        "| Task | Model | Solves | Observed pass rate | pass@1 | pass@3 | pass@8 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for cell in cells:
        lines.append(
            f"| {cell['task_label']} | {cell['model_label']} | "
            f"{cell['solves']}/{cell['attempts']} | {cell['observed_pass_rate']:.1%} | "
            f"{cell['pass_at_1']:.4f} | {cell['pass_at_3']:.4f} | {cell['pass_at_8']:.4f} |"
        )
    lines.extend(
        [
            "",
            "## Model totals",
            "",
            "| Model | Solves | Observed pass rate |",
            "| --- | ---: | ---: |",
        ]
    )
    for total in model_totals:
        lines.append(
            f"| {total['model_label']} | {total['solves']}/{total['attempts']} | "
            f"{total['observed_pass_rate']:.2%} |"
        )
    lines.extend(
        [
            "",
            "The observed pass rate is the raw solve fraction. `pass@k` uses "
            "`1 - C(n-c, k) / C(n, k)`.",
            "",
        ]
    )
    MATRIX_PATH.write_text("\n".join(lines))

    MANIFEST_PATH.write_text(
        json.dumps(
            {
                "tasks": list(TASKS),
                "models": list(MODELS),
                "validTrials": len(trials),
                "excludedTrials": 0,
                "attemptsPerTaskModelCell": 8,
                "trajectoryRoot": RAW_ROOT.as_posix(),
                "sourceCommit": "cae33b207f8104b04aa3f9ed1a46cc0526c79b5a",
                "artifactTransformations": {
                    "layout": "canonical Task 14 trials placed in the destination raw-cohort layout",
                    "metadata": "cohort-local result and lock paths normalized to destination names",
                    "preserved": "agent trajectories, transcripts, verifier artifacts, rewards, tokens, costs, and frozen identities",
                },
                "cells": cells,
                "modelTotals": model_totals,
                "controls": controls,
                "denominatorPolicy": (
                    "numeric verifier reward; complete normalized and native trajectory, "
                    "transcript, result, lock, and verifier artifacts; one frozen task digest "
                    "and result checksum per cell; no Harbor exception"
                ),
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"indexed={len(trials)} cells={len(cells)} missing=0 "
        f"totals={[(item['model_label'], item['solves']) for item in model_totals]}"
    )


if __name__ == "__main__":
    main()
