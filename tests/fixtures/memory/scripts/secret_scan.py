#!/usr/bin/env python3
"""Conservative local secret scan with no third-party dependencies."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from memory_common import ROOT

EXCLUDED_DIRS = {".git", "__pycache__", ".pytest_cache"}
MAX_BYTES = 2_000_000
PATTERNS = [
    ("private key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{16,}\b")),
    ("Bearer token", re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    ("cookie header", re.compile(r"(?i)^\s*(?:set-)?cookie\s*:\s*[^\s;=]+=[^\s;]{8,}", re.MULTILINE)),
]
ASSIGNMENT_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)"
    r"\s*[:=]\s*['\"]?([^\s'\"#,;]{8,})"
)
PLACEHOLDERS = {"changeme", "example", "placeholder", "redacted", "your_key_here", "your-token", "xxxxxxxx"}


def scan_text(text: str) -> list[str]:
    hits = [name for name, pattern in PATTERNS if pattern.search(text)]
    for match in ASSIGNMENT_RE.finditer(text):
        value = match.group(1).strip().lower()
        if value not in PLACEHOLDERS and not value.startswith(("${", "<", "your_")):
            hits.append("credential assignment")
            break
    return hits


def iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        if any(part in EXCLUDED_DIRS for part in path.relative_to(root).parts):
            continue
        if path.is_symlink():
            yield path
        elif path.is_file():
            yield path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.path.resolve()
    errors: list[str] = []

    for path in iter_files(root):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            errors.append(f"{rel}: symbolic link is not scanned safely")
            continue
        try:
            data = path.read_bytes()
        except OSError as exc:
            errors.append(f"{rel}: cannot read: {exc}")
            continue
        if len(data) > MAX_BYTES:
            errors.append(f"{rel}: file exceeds {MAX_BYTES} bytes and was not scanned")
            continue
        if b"\x00" in data:
            errors.append(f"{rel}: binary file is not allowed")
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"{rel}: non-UTF-8 file is not allowed")
            continue
        for hit in scan_text(text):
            errors.append(f"{rel}: possible {hit}")

    if errors:
        for error in errors:
            print(f"SECRET SCAN FAILED: {error}", file=sys.stderr)
        return 1
    print("secret scan: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
