#!/usr/bin/env python3
"""Validate memory schema, layout, duplicates, references, and local links (both zones)."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

from memory_common import (
    ALLOWED_SUBDIRS,
    LAYERS,
    PROJECTS_DIR,
    PROJECT_CATEGORIES,
    ROOT,
    expected_indexes,
    iter_memory_paths,
    project_names,
    validate_record,
)

LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")


def validate_layout(root: Path) -> list[str]:
    errors: list[str] = []
    for layer in LAYERS:
        base = root / layer
        if not base.is_dir():
            errors.append(f"missing layer directory: {layer}/")
            continue
        allowed = ALLOWED_SUBDIRS[layer]
        for path in base.rglob("*"):
            rel = path.relative_to(root).as_posix()
            if path.is_symlink():
                errors.append(f"{rel}: symbolic links are not allowed")
                continue
            if path.is_dir():
                depth = len(path.relative_to(base).parts)
                if depth > 1:
                    errors.append(f"{rel}: directories deeper than one category are not allowed")
                elif path.name not in allowed:
                    errors.append(f"{rel}: unapproved category for {layer}/")
            elif path.suffix != ".md":
                errors.append(f"{rel}: only Markdown files are allowed in formal layers")

    base = root / PROJECTS_DIR
    if base.exists():
        if not base.is_dir():
            errors.append(f"{PROJECTS_DIR}: must be a directory")
            return errors
        for entry in sorted(base.iterdir()):
            rel = entry.relative_to(root).as_posix()
            if entry.is_symlink():
                errors.append(f"{rel}: symbolic links are not allowed")
                continue
            if not entry.is_dir():
                if entry.name != "README.md":
                    errors.append(f"{rel}: only project directories are allowed directly under projects/")
                continue
            if not (entry / "README.md").is_file():
                errors.append(f"{rel}/README.md: project router README is missing")
            for path in entry.rglob("*"):
                if path.is_symlink():
                    errors.append(f"{path.relative_to(root).as_posix()}: symbolic links are not allowed")
                    continue
                path_rel = path.relative_to(root).as_posix()
                if path.is_dir():
                    depth = len(path.relative_to(entry).parts)
                    if depth > 1:
                        errors.append(f"{path_rel}: project directories deeper than one category are not allowed")
                    elif path.name not in PROJECT_CATEGORIES:
                        errors.append(
                            f"{path_rel}: unapproved project category (expected one of {sorted(PROJECT_CATEGORIES)})"
                        )
                elif path.suffix != ".md":
                    errors.append(f"{path_rel}: only Markdown files are allowed in the project zone")
    return errors


def validate_links(root: Path) -> list[str]:
    errors: list[str] = []
    for path in sorted(root.rglob("*.md")):
        if ".git" in path.parts or path.is_symlink():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        for raw_target in LINK_RE.findall(text):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target_path = target.split("#", 1)[0]
            resolved = (path.parent / unquote(target_path)).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                errors.append(f"{path.relative_to(root)}: link escapes repository: {target}")
                continue
            if not resolved.exists():
                errors.append(f"{path.relative_to(root)}: broken local link: {target}")
    return errors


def _check_duplicates(active: list, label: str, errors: list[str]) -> None:
    seen_titles: dict[str, str] = {}
    seen_descriptions: dict[str, str] = {}
    for record in active:
        for field, seen in (("title", seen_titles), ("description", seen_descriptions)):
            value = record.metadata.get(field)
            if not isinstance(value, str):
                continue
            key = "".join(value.casefold().split())
            if key in seen:
                errors.append(f"{record.relative_path}: duplicate active {field} in {label} with {seen[key]}")
            else:
                seen[key] = record.relative_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    errors = validate_layout(root)
    records = []

    for path in iter_memory_paths(root):
        record, record_errors = validate_record(path, root)
        rel = path.relative_to(root).as_posix()
        errors.extend(f"{rel}: {error}" for error in record_errors)
        if record is not None:
            records.append(record)

    def is_active(record) -> bool:
        return record.metadata.get("status") == "active"

    _check_duplicates(
        [r for r in records if r.zone == "personal" and is_active(r)], "personal zone", errors
    )
    for name in project_names(root):
        _check_duplicates(
            [r for r in records if r.zone == "project" and r.project == name and is_active(r)],
            f"project {name}",
            errors,
        )

    for record in records:
        supersedes = record.metadata.get("supersedes")
        if supersedes and not (root / supersedes).is_file():
            errors.append(f"{record.relative_path}: supersedes target does not exist: {supersedes}")

    errors.extend(validate_links(root))

    for path, expected in expected_indexes(root, records).items():
        actual = path.read_text(encoding="utf-8") if path.exists() else ""
        if actual != expected:
            errors.append(f"{path.relative_to(root).as_posix()} is stale; run `make index`")

    if errors:
        for error in errors:
            print(f"VALIDATION FAILED: {error}", file=sys.stderr)
        return 1

    personal = sum(1 for r in records if r.zone == "personal")
    project = sum(1 for r in records if r.zone == "project")
    print(
        f"validation: OK (personal: {personal} memories, "
        f"projects: {len(project_names(root))} project(s), {project} memories)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
