#!/usr/bin/env python3
"""Validate the historical cohort and render the combined Task 1-4 matrix."""

from __future__ import annotations

import json
from collections import defaultdict
from math import comb
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
START = "<!-- MINI_SWE_MATRIX_START -->"
END = "<!-- MINI_SWE_MATRIX_END -->"
MACRO_START = "<!-- MINI_SWE_MACRO_START -->"
MACRO_END = "<!-- MINI_SWE_MACRO_END -->"
REPORT_RESULTS_PATH = ROOT / "sample-run" / "manifests" / "report-results.json"
REPORT_OPUS5_INDEX = ROOT / "sample-run" / "indexes" / "report-opus5-trials.json"
# Both routes serve the same Claude Opus 4.8 weights.
MODELS = (
    "bedrock/us.anthropic.claude-opus-4-8",
    "openrouter/anthropic/claude-opus-4.8",
)
MODEL_LABEL = "Opus 4.8"
REPORT_MODEL_LABEL = "Opus 5"
COHORT = json.loads((ROOT / "harness" / "cohort.json").read_text())
CONTROLS = json.loads((ROOT / "harness" / "controls.json").read_text())
RAW = ROOT / "sample-run" / "raw" / COHORT["job_name"]
CONTROLS_RAW = ROOT / "sample-run" / "raw" / CONTROLS["job_name"]
TASKS = [Path(entry["path"]).name for entry in COHORT["tasks"]]
TASK_LABELS = {task: f"Task {index}" for index, task in enumerate(TASKS, start=1)}
TARGET = int(COHORT["n_attempts"])


def first_existing(*paths: Path) -> Path | None:
    return next((path for path in paths if path.is_file()), None)


def pass_at_k(n: int, c: int, k: int) -> float:
    if c == 0:
        return 0.0
    if n - c < k:
        return 1.0
    return 1.0 - comb(n - c, k) / comb(n, k)


def task_digest(trial_dir: Path) -> str | None:
    lock_path = trial_dir / "lock.json"
    if not lock_path.is_file():
        return None
    try:
        return (json.loads(lock_path.read_text()).get("task") or {}).get("digest")
    except (OSError, json.JSONDecodeError):
        return None


def load_trials() -> list[dict]:
    trials = []
    for result_path in sorted(RAW.glob("*/result.json")):
        try:
            result = json.loads(result_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        trial_dir = result_path.parent
        config = result.get("config") or {}
        task = Path(str(((config.get("task") or {}).get("path")) or "")).name
        model = (config.get("agent") or {}).get("model_name")
        if task not in TASKS or model not in MODELS:
            continue
        reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get(
            "reward"
        )
        trajectory = first_existing(trial_dir / "agent" / "trajectory.json")
        native_trajectory = first_existing(
            trial_dir / "agent" / "mini-swe-agent.trajectory.json"
        )
        verifier = first_existing(
            trial_dir / "verifier" / "reward.json",
            trial_dir / "verifier" / "output.json",
        )
        digest = task_digest(trial_dir)
        valid = (
            result.get("exception_info") is None
            and isinstance(reward, (int, float))
            and trajectory is not None
            and native_trajectory is not None
            and verifier is not None
            and digest is not None
        )
        agent_result = result.get("agent_result") or {}
        trials.append(
            {
                "task": task,
                "task_label": TASK_LABELS[task],
                "model": model,
                "model_label": MODEL_LABEL,
                "reward": reward,
                "passed": bool(valid and float(reward) >= 1.0),
                "valid": valid,
                "trial_dir": trial_dir.relative_to(ROOT).as_posix(),
                "trajectory": trajectory.relative_to(ROOT).as_posix()
                if trajectory
                else None,
                "native_trajectory": native_trajectory.relative_to(ROOT).as_posix()
                if native_trajectory
                else None,
                "verifier": verifier.relative_to(ROOT).as_posix()
                if verifier
                else None,
                "exception_info": result.get("exception_info"),
                "input_tokens": agent_result.get("n_input_tokens"),
                "cache_tokens": agent_result.get("n_cache_tokens"),
                "output_tokens": agent_result.get("n_output_tokens"),
                "reported_cost_usd": agent_result.get("cost_usd"),
                "task_digest": digest,
                "legacy_task_checksum": result.get("task_checksum"),
            }
        )
    return trials


def load_report_cells() -> dict[str, dict[str, dict]]:
    if not REPORT_RESULTS_PATH.is_file():
        raise SystemExit("report results manifest is missing")
    report = json.loads(REPORT_RESULTS_PATH.read_text())
    if report.get("attempts_per_task_model") != TARGET:
        raise SystemExit("report attempt count does not match the cohort target")

    cells: dict[str, dict[str, dict]] = defaultdict(dict)
    for cell in report.get("cells", []):
        task = cell.get("task")
        model_label = cell.get("model_label")
        if task not in TASKS or model_label not in {MODEL_LABEL, REPORT_MODEL_LABEL}:
            raise SystemExit(f"unexpected report cell: {cell}")
        if model_label in cells[task]:
            raise SystemExit(f"duplicate report cell for {task} {model_label}")
        if (
            cell.get("attempts") != TARGET
            or not isinstance(cell.get("solves"), int)
            or not 0 <= cell["solves"] <= TARGET
        ):
            raise SystemExit(f"invalid report denominator for {task} {model_label}")
        cells[task][model_label] = cell

    missing = [
        (task, model_label)
        for task in TASKS
        for model_label in (MODEL_LABEL, REPORT_MODEL_LABEL)
        if model_label not in cells[task]
    ]
    if missing:
        raise SystemExit(f"report cells are missing: {missing}")

    report_opus5_trials = json.loads(REPORT_OPUS5_INDEX.read_text())
    indexed_opus5_solves: dict[str, int] = defaultdict(int)
    indexed_opus5_attempts: dict[str, int] = defaultdict(int)
    for trial in report_opus5_trials:
        task = trial.get("task")
        if task in TASKS and trial.get("valid"):
            indexed_opus5_attempts[task] += 1
            indexed_opus5_solves[task] += bool(trial.get("passed"))
    for task in TASKS:
        cell = cells[task][REPORT_MODEL_LABEL]
        if (
            indexed_opus5_attempts[task] != cell["attempts"]
            or indexed_opus5_solves[task] != cell["solves"]
        ):
            raise SystemExit(f"report Opus 5 index mismatch for {task}")
    return cells


def load_controls(expected_task_digests: dict[str, str]) -> dict:
    rewards: dict[str, list[float]] = defaultdict(list)
    digest_matches = []
    for result_path in sorted(CONTROLS_RAW.glob("*/result.json")):
        result = json.loads(result_path.read_text())
        config = result.get("config") or {}
        agent = (config.get("agent") or {}).get("name")
        task = Path(str(((config.get("task") or {}).get("path")) or "")).name
        reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get(
            "reward"
        )
        digest = task_digest(result_path.parent)
        if (
            task in expected_task_digests
            and agent in {"oracle", "nop"}
            and isinstance(reward, (int, float))
        ):
            rewards[agent].append(float(reward))
            digest_matches.append(digest == expected_task_digests[task])
    controls = {
        "cohort_directory": CONTROLS_RAW.relative_to(ROOT).as_posix(),
        "task_digests": expected_task_digests,
        "task_digests_match_scored": len(digest_matches) == 2 * len(TASKS)
        and all(digest_matches),
        "oracle": {
            "count": len(rewards["oracle"]),
            "all_reward_one": len(rewards["oracle"]) == len(TASKS)
            and all(value == 1.0 for value in rewards["oracle"]),
        },
        "nop": {
            "count": len(rewards["nop"]),
            "all_reward_zero": len(rewards["nop"]) == len(TASKS)
            and all(value == 0.0 for value in rewards["nop"]),
        },
    }
    if (
        not controls["task_digests_match_scored"]
        or not controls["oracle"]["all_reward_one"]
        or not controls["nop"]["all_reward_zero"]
    ):
        raise SystemExit(f"control gate failed: {controls}")
    return controls


def historical_matrix(cells: dict[str, list[dict]], prefix: str) -> str:
    lines = [
        START,
        "| Task | Model | Solves `c/n` | pass@1 | pass@3 | pass@8 |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for task in TASKS:
        valid = cells[task]
        n = len(valid)
        c = sum(item["passed"] for item in valid)
        values = [pass_at_k(n, c, k) for k in (1, 3, 8)]
        lines.append(
            f"| [{TASK_LABELS[task]}]({prefix}tasks/{task}/instruction.md) | "
            f"{MODEL_LABEL} | {c}/{n} | "
            + " | ".join(f"{value:.4f}" for value in values)
            + " |"
        )
    lines.append(END)
    return "\n".join(lines)


def report_matrix(cells: dict[str, dict[str, dict]], prefix: str) -> str:
    lines = [
        START,
        "| Task | Model | Solves `c/n` | pass@1 | pass@3 | pass@8 |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for task in TASKS:
        for model_label in (MODEL_LABEL, REPORT_MODEL_LABEL):
            cell = cells[task][model_label]
            n = cell["attempts"]
            c = cell["solves"]
            values = [pass_at_k(n, c, k) for k in (1, 3, 8)]
            lines.append(
                f"| [{TASK_LABELS[task]}]({prefix}tasks/{task}/instruction.md) | "
                f"{model_label} | {c}/{n} | "
                + " | ".join(f"{value:.4f}" for value in values)
                + " |"
            )
    lines.append(END)
    return "\n".join(lines)


def historical_macro(cells: dict[str, list[dict]]) -> str:
    total_valid = 0
    total_passes = 0
    per_task_pass_at_k = []
    for task in TASKS:
        valid = cells[task]
        n = len(valid)
        c = sum(item["passed"] for item in valid)
        total_valid += n
        total_passes += c
        per_task_pass_at_k.append([pass_at_k(n, c, k) for k in (1, 3, 8)])
    macro_values = [
        sum(row[index] for row in per_task_pass_at_k) / len(per_task_pass_at_k)
        for index in range(3)
    ]
    return "\n".join(
        [
            MACRO_START,
            "Unweighted macro-average across the four tasks:",
            "",
            "| Model | Valid solves | Raw solve rate | pass@1 | pass@3 | pass@8 |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
            f"| {MODEL_LABEL} | {total_passes}/{total_valid} | "
            f"{100 * total_passes / total_valid:.1f}% | "
            + " | ".join(f"{value:.4f}" for value in macro_values)
            + " |",
            MACRO_END,
        ]
    )


def report_macro(cells: dict[str, dict[str, dict]]) -> str:
    lines = [
        MACRO_START,
        "Unweighted macro-average across Tasks 1-4:",
        "",
        "| Model | Valid solves | Raw solve rate | pass@1 | pass@3 | pass@8 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model_label in (MODEL_LABEL, REPORT_MODEL_LABEL):
        total_valid = 0
        total_passes = 0
        per_task_pass_at_k = []
        for task in TASKS:
            cell = cells[task][model_label]
            n = cell["attempts"]
            c = cell["solves"]
            total_valid += n
            total_passes += c
            per_task_pass_at_k.append([pass_at_k(n, c, k) for k in (1, 3, 8)])
        macro_values = [
            sum(row[index] for row in per_task_pass_at_k) / len(TASKS)
            for index in range(3)
        ]
        lines.append(
            f"| {model_label} | {total_passes}/{total_valid} | "
            f"{100 * total_passes / total_valid:.1f}% | "
            + " | ".join(f"{value:.4f}" for value in macro_values)
            + " |"
        )
    lines.append(MACRO_END)
    return "\n".join(lines)


def main() -> None:
    trials = load_trials()
    report_cells = load_report_cells()
    cells: dict[str, list[dict]] = defaultdict(list)
    for trial in trials:
        if trial["valid"]:
            cells[trial["task"]].append(trial)
    incomplete = {task: len(cells[task]) for task in TASKS if len(cells[task]) != TARGET}
    if incomplete:
        raise SystemExit(f"expected exactly {TARGET} valid trials per task: {incomplete}")

    expected_task_digests = {}
    for task in TASKS:
        digests = {item["task_digest"] for item in cells[task]}
        if len(digests) != 1:
            raise SystemExit(f"scored task digest mismatch for {task}: {sorted(digests)}")
        expected_task_digests[task] = digests.pop()
    controls = load_controls(expected_task_digests)
    summaries = []
    for task in TASKS:
        valid = cells[task]
        n = len(valid)
        c = sum(item["passed"] for item in valid)
        values = [pass_at_k(n, c, k) for k in (1, 3, 8)]
        summaries.append(
            {
                "task": task,
                "task_label": TASK_LABELS[task],
                "model": valid[0]["model"],
                "valid": n,
                "passes": c,
                "pass_at_1": values[0],
                "pass_at_3": values[1],
                "pass_at_8": values[2],
            }
        )

    index_dir = ROOT / "sample-run" / "indexes"
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "trials.json").write_text(json.dumps(trials, indent=2) + "\n")
    (index_dir / "execution-summary.json").write_text(
        json.dumps(
            {
                "cohort_directory": RAW.relative_to(ROOT).as_posix(),
                "models": list(MODELS),
                "attempts_per_task": TARGET,
                "scored_valid_trials": sum(item["valid"] for item in trials),
                "completed_trials_excluded_from_denominator": sum(
                    not item["valid"] for item in trials
                ),
                "cells": summaries,
                "controls": controls,
                "denominator_policy": (
                    "numeric verifier reward, complete ATIF and native mini-SWE "
                    "trajectories, complete verifier artifact, and no Harbor exception"
                ),
            },
            indent=2,
        )
        + "\n"
    )

    readme_matrix = report_matrix(report_cells, "")
    index_matrix = historical_matrix(cells, "../../")
    historical_macro_table = historical_macro(cells)
    report_macro_table = report_macro(report_cells)
    (index_dir / "pass-rate-matrix.md").write_text(
        index_matrix + "\n\n" + historical_macro_table + "\n"
    )
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text()
    if START not in readme or END not in readme:
        raise SystemExit("README matrix markers are missing")
    prefix, rest = readme.split(START, 1)
    _, suffix = rest.split(END, 1)
    readme = prefix + readme_matrix + suffix
    if MACRO_START not in readme or MACRO_END not in readme:
        raise SystemExit("README macro markers are missing")
    prefix, rest = readme.split(MACRO_START, 1)
    _, suffix = rest.split(MACRO_END, 1)
    readme_path.write_text(prefix + report_macro_table + suffix)
    print(f"indexed={len(trials)} valid={sum(item['valid'] for item in trials)} excluded={sum(not item['valid'] for item in trials)}")


if __name__ == "__main__":
    main()
