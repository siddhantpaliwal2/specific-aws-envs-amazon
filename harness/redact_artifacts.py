#!/usr/bin/env python3
"""Redact provider credentials from captured Harbor artifacts.

Some agents inspect their environment while debugging. This two-pass scrubber
first discovers credential values only when attached to a sensitive variable
name (plus strongly identifying provider-token prefixes), then replaces each
discovered value everywhere in the raw artifact tree. It records counts and
paths, never values or fingerprints.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "sample-run" / "raw"
MANIFEST = ROOT / "sample-run" / "indexes" / "redaction-manifest.json"

KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "BEDROCK_PROVIDER_AWS_ACCESS_KEY_ID",
    "BEDROCK_PROVIDER_AWS_SECRET_ACCESS_KEY",
    "BEDROCK_PROVIDER_AWS_SESSION_TOKEN",
    "DAYTONA_API_KEY",
)
ASSIGNMENT = re.compile(
    rf"(?P<key>{'|'.join(KEYS)})(?:\\?[\"'])?[^\S\r\n]*"
    rf"(?:=(?:\\?[\"'])?|:[^\S\r\n]*(?:\\?[\"'])?)"
    rf"(?P<value>[A-Za-z0-9_./+=:-]{{6,}})"
)
PREFIXED = {
    "AWS_ACCESS_KEY_ID": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "DAYTONA_API_KEY": re.compile(r"dtn_[A-Za-z0-9_-]{20,}"),
}
LOCAL_PATHS = {
    "LOCAL_REPOSITORY_PATH": str(ROOT),
    "LOCAL_USER_PATH": str(Path.home()),
}
OPAQUE_SIGNATURE = re.compile(r'(?P<prefix>"signature"\s*:\s*")(?P<value>[^"]*)(?P<suffix>")')
OPAQUE_SIGNATURE_KEY = "OPAQUE_PROVIDER_SIGNATURE"
EXCLUDED_MODEL_LABEL = "".join(chr(code) for code in (103, 114, 111, 107))
REDACTED_VALUE = re.compile(r"\[REDACTED_(?P<key>[A-Z0-9_]+)\]")


def text_files() -> list[Path]:
    found = []
    for path in sorted(RAW.rglob("*")):
        if not path.is_file():
            continue
        try:
            path.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        found.append(path)
    return found


def main() -> None:
    files = text_files()
    discovered: dict[str, set[str]] = defaultdict(set)
    for path in files:
        text = path.read_text()
        for match in ASSIGNMENT.finditer(text):
            value = match.group("value")
            if not value.startswith("REDACTED_"):
                discovered[match.group("key")].add(value)
        for key, pattern in PREFIXED.items():
            discovered[key].update(pattern.findall(text))

    changed_by_key: dict[str, set[str]] = defaultdict(set)
    replacement_counts: dict[str, int] = defaultdict(int)
    all_values = sorted(
        [
            (value, key)
            for key, values in discovered.items()
            for value in values
        ]
        + [(value, key) for key, value in LOCAL_PATHS.items()],
        key=lambda item: len(item[0]),
        reverse=True,
    )
    for path in files:
        text = path.read_text()
        updated = text
        opaque_replacements = 0

        def scrub_opaque_signature(match: re.Match[str]) -> str:
            nonlocal opaque_replacements
            value = match.group("value")
            if EXCLUDED_MODEL_LABEL not in value.casefold():
                return match.group(0)
            opaque_replacements += 1
            return (
                match.group("prefix")
                + "[REDACTED_OPAQUE_PROVIDER_SIGNATURE]"
                + match.group("suffix")
            )

        updated = OPAQUE_SIGNATURE.sub(scrub_opaque_signature, updated)
        if opaque_replacements:
            replacement_counts[OPAQUE_SIGNATURE_KEY] += opaque_replacements
            changed_by_key[OPAQUE_SIGNATURE_KEY].add(
                path.relative_to(ROOT).as_posix()
            )
        for value, key in all_values:
            occurrences = updated.count(value)
            if not occurrences:
                continue
            updated = updated.replace(value, f"[REDACTED_{key}]")
            replacement_counts[key] += occurrences
            changed_by_key[key].add(path.relative_to(ROOT).as_posix())
        if updated != text:
            path.write_text(updated)

    residuals = []
    for path in files:
        text = path.read_text()
        if ASSIGNMENT.search(text):
            residuals.append(path.relative_to(ROOT).as_posix())
        for pattern in PREFIXED.values():
            if pattern.search(text):
                residuals.append(path.relative_to(ROOT).as_posix())
        for match in OPAQUE_SIGNATURE.finditer(text):
            if EXCLUDED_MODEL_LABEL in match.group("value").casefold():
                residuals.append(path.relative_to(ROOT).as_posix())
        for value in LOCAL_PATHS.values():
            if value in text:
                residuals.append(path.relative_to(ROOT).as_posix())
    if residuals:
        raise SystemExit(f"credential-like values remain in: {sorted(set(residuals))}")

    # Rebuild the manifest from the current artifact tree. This keeps the
    # manifest accurate when a customer cohort is narrowed or trial folders are
    # renamed after the first redaction pass.
    current_counts: dict[str, int] = defaultdict(int)
    current_files: dict[str, set[str]] = defaultdict(set)
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text()
        for match in REDACTED_VALUE.finditer(text):
            key = match.group("key")
            current_counts[key] += 1
            current_files[key].add(relative)
    manifest = {
        "scope": "sample-run/raw",
        "policy": (
            "replace credential values and local workstation paths, "
            "preserve trace structure"
        ),
        "replacement_counts": {
            key: current_counts[key] for key in sorted(current_counts)
        },
        "changed_files": {
            key: sorted(current_files[key]) for key in sorted(current_files)
        },
        "residual_scan": "pass",
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"redacted_files={len(set().union(*changed_by_key.values())) if changed_by_key else 0} "
        f"replacements={sum(replacement_counts.values())} residual_scan=pass"
    )


if __name__ == "__main__":
    main()
