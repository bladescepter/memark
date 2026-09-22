#!/usr/bin/env python3
"""Generate or verify INDEX.md files (personal root + per-project) for the memory repository."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from memory_common import ROOT, expected_indexes, iter_memory_paths, validate_record


def build(root: Path) -> tuple[list, list[str]]:
    records = []
    errors: list[str] = []
    for path in iter_memory_paths(root):
        record, record_errors = validate_record(path, root)
        rel = path.relative_to(root).as_posix()
        errors.extend(f"{rel}: {error}" for error in record_errors)
        if record is not None:
            records.append(record)
    return records, errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if any INDEX.md is stale; do not write")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    records, errors = build(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    indexes = expected_indexes(root, records)
    if args.check:
        stale = []
        for path, expected in indexes.items():
            actual = path.read_text(encoding="utf-8") if path.exists() else ""
            if actual != expected:
                stale.append(path.relative_to(root).as_posix())
        if stale:
            print("ERROR: stale index files; run `make index`: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"index: OK ({len(indexes)} index file(s))")
        return 0

    for path, expected in indexes.items():
        path.write_text(expected, encoding="utf-8")
        print(f"index: wrote {path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
