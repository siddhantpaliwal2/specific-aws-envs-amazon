#!/usr/bin/env python3
"""Record replay-affecting checksums without reading generated run artifacts."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "harness" / "cohort.json").read_text())


def directory_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
        if ".git" in item.parts or "__pycache__" in item.parts or item.name == ".DS_Store":
            continue
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def version(command: list[str]) -> str:
    return subprocess.check_output(command, text=True).strip()


def main() -> None:
    tasks = {}
    for entry in CONFIG["tasks"]:
        task_path = ROOT / entry["path"]
        tasks[task_path.name] = directory_sha256(task_path)
    task_labels = {
        task: f"Task {index}" for index, task in enumerate(tasks, start=1)
    }

    payload = {
        "cohort": CONFIG["job_name"],
        "attempts_per_task_model": CONFIG["n_attempts"],
        "validity_rule": "complete verifier reward and no Harbor exception",
        "harbor_version": version(["harbor", "--version"]),
        "mini_swe_agent_version": "2.4.5",
        "model": "bedrock/us.anthropic.claude-opus-4-8",
        "agent": "mini-swe-agent",
        "reasoning_effort": "high",
        "environment": "daytona",
        "task_labels": task_labels,
        "task_sha256": tasks,
        "cohort_config_sha256": hashlib.sha256(
            (ROOT / "harness" / "cohort.json").read_bytes()
        ).hexdigest(),
        "controls_config_sha256": hashlib.sha256(
            (ROOT / "harness" / "controls.json").read_bytes()
        ).hexdigest(),
        "bedrock_config_sha256": hashlib.sha256(
            (ROOT / "harness" / "mini-swe-bedrock.yaml").read_bytes()
        ).hexdigest(),
        "adapter_sha256": hashlib.sha256(
            (ROOT / "harness" / "harbor_agents.py").read_bytes()
        ).hexdigest(),
    }
    destination = ROOT / "sample-run" / "manifests" / "frozen-cohort.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(destination.relative_to(ROOT))


if __name__ == "__main__":
    main()
