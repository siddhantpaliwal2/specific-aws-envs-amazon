#!/usr/bin/env python3
"""Validate and index the four-task Claude Opus 4.8 customer cohort."""

from __future__ import annotations

import json
from collections import defaultdict
from math import comb
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
START = "<!-- MINI_SWE_MATRIX_START -->"
END = "<!-- MINI_SWE_MATRIX_END -->"
# Both routes serve the same Claude Opus 4.8 weights.
MODELS = (
    "bedrock/us.anthropic.claude-opus-4-8",
    "openrouter/anthropic/claude-opus-4.8",
)
MODEL_LABEL = "Opus 4.8"
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
        valid = (
            result.get("exception_info") is None
            and isinstance(reward, (int, float))
            and trajectory is not None
            and native_trajectory is not None
            and verifier is not None
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
            }
        )
    return trials


def load_controls() -> dict:
    rewards: dict[str, list[float]] = defaultdict(list)
    for result_path in sorted(CONTROLS_RAW.glob("*/result.json")):
        result = json.loads(result_path.read_text())
        agent = ((result.get("config") or {}).get("agent") or {}).get("name")
        reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get(
            "reward"
        )
        if agent in {"oracle", "nop"} and isinstance(reward, (int, float)):
            rewards[agent].append(float(reward))
    controls = {
        "cohort_directory": CONTROLS_RAW.relative_to(ROOT).as_posix(),
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
    if not controls["oracle"]["all_reward_one"] or not controls["nop"][
        "all_reward_zero"
    ]:
        raise SystemExit(f"control gate failed: {controls}")
    return controls


def matrix(cells: dict[str, list[dict]], prefix: str) -> str:
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


def main() -> None:
    trials = load_trials()
    cells: dict[str, list[dict]] = defaultdict(list)
    for trial in trials:
        if trial["valid"]:
            cells[trial["task"]].append(trial)
    incomplete = {task: len(cells[task]) for task in TASKS if len(cells[task]) != TARGET}
    if incomplete:
        raise SystemExit(f"expected exactly {TARGET} valid trials per task: {incomplete}")

    controls = load_controls()
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

    readme_matrix = matrix(cells, "")
    index_matrix = matrix(cells, "../../")
    (index_dir / "pass-rate-matrix.md").write_text(index_matrix + "\n")
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text()
    if START not in readme or END not in readme:
        raise SystemExit("README matrix markers are missing")
    prefix, rest = readme.split(START, 1)
    _, suffix = rest.split(END, 1)
    readme_path.write_text(prefix + readme_matrix + suffix)
    print(f"indexed={len(trials)} valid={sum(item['valid'] for item in trials)} excluded={sum(not item['valid'] for item in trials)}")


if __name__ == "__main__":
    main()
