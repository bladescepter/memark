#!/usr/bin/env python3
"""Shared parser and repository rules for the memory repository.

Repository zones:
- Personal zone: five layers (identity/principles/preferences/context/knowledge),
  admission standard = valid across projects.
- Project zone: projects/<name>/{decisions,topics,incidents,handoffs},
  admission standard = valid within a single project; scope must be "project".
"""

from __future__ import annotations

import ast
import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]

# --- Personal zone (five layers) ---
LAYERS = ("identity", "principles", "preferences", "context", "knowledge")
ALLOWED_SUBDIRS = {
    "identity": set(),
    "principles": set(),
    "preferences": set(),
    "context": {"current", "relationships"},
    "knowledge": {"skills", "experiences", "learnings"},
}
TYPE_BY_LAYER = {
    "identity": {"Identity"},
    "principles": {"Principle"},
    "preferences": {"Preference"},
    "context": {"Context"},
    "knowledge": {"Skill", "Experience", "Learning"},
}

# --- Project zone ---
PROJECTS_DIR = "projects"
PROJECT_CATEGORIES = {"decisions", "topics", "incidents", "handoffs"}
TYPE_BY_PROJECT_CATEGORY = {
    "decisions": {"Decision"},
    "topics": {"Topic"},
    "incidents": {"Incident"},
    "handoffs": {"Handoff"},
}
PROJECT_TYPES = {"Decision", "Topic", "Incident", "Handoff"}

REQUIRED_FIELDS = {
    "type", "title", "description", "status", "privacy", "tags", "timestamp", "reviewed"
}
ALLOWED_FIELDS = REQUIRED_FIELDS | {"scope", "source", "expires", "supersedes"}
STATUSES = {"active", "archived", "superseded"}
PRIVACY = {"internal", "public"}
SCOPES = {"user", "project", "workflow", "context"}
SOURCES = {"user-explicit", "user-confirmed", "verified-file", "runtime-verified"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class FrontmatterError(ValueError):
    pass


@dataclass(frozen=True)
class MemoryRecord:
    path: Path
    relative_path: str
    zone: str  # "personal" | "project"
    project: str | None  # project name for the project zone
    metadata: dict[str, Any]
    body: str


def _parse_scalar(raw: str, line_number: int) -> Any:
    value = raw.strip()
    if not value:
        raise FrontmatterError(f"line {line_number}: value must not be empty")
    if value in {"null", "~"}:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if value.startswith("["):
        if not value.endswith("]"):
            raise FrontmatterError(f"line {line_number}: malformed inline list")
        inner = value[1:-1].strip()
        if not inner:
            return []
        items = []
        for item in inner.split(","):
            item = item.strip()
            if not item:
                raise FrontmatterError(f"line {line_number}: empty list item")
            if item[:1] in {"'", '"'}:
                try:
                    item = ast.literal_eval(item)
                except (SyntaxError, ValueError) as exc:
                    raise FrontmatterError(f"line {line_number}: malformed quoted value") from exc
            items.append(item)
        return items
    if value[:1] in {"'", '"'}:
        try:
            return ast.literal_eval(value)
        except (SyntaxError, ValueError) as exc:
            raise FrontmatterError(f"line {line_number}: malformed quoted value") from exc
    return value


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise FrontmatterError("frontmatter must start on the first line with ---")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as exc:
        raise FrontmatterError("frontmatter closing --- is missing") from exc

    metadata: dict[str, Any] = {}
    for i, line in enumerate(lines[1:end], start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[:1].isspace() or ":" not in line:
            raise FrontmatterError(f"line {i}: only single-line key: value fields are allowed")
        key, raw = line.split(":", 1)
        key = key.strip()
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", key):
            raise FrontmatterError(f"line {i}: invalid field name {key!r}")
        if key in metadata:
            raise FrontmatterError(f"line {i}: duplicate field {key!r}")
        metadata[key] = _parse_scalar(raw, i)

    body = "\n".join(lines[end + 1 :]).strip()
    return metadata, body


def _valid_date(value: Any) -> bool:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_record(path: Path, root: Path = ROOT) -> tuple[MemoryRecord | None, list[str]]:
    errors: list[str] = []
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        return None, ["path escapes repository root"]
    rel = relative.as_posix()
    parts = relative.parts

    layer = parts[0] if parts else ""
    zone: str | None = None
    project: str | None = None
    if layer in LAYERS:
        zone = "personal"
    elif layer == PROJECTS_DIR and len(parts) >= 2:
        zone = "project"
        project = parts[1]
    if zone is None:
        return None, ["not inside a formal memory zone (five layers or projects/<name>/)"]

    if path.is_symlink():
        errors.append("symbolic links are not allowed for memory files")
    if any(ch.isspace() for ch in path.name):
        errors.append("file names must not contain whitespace (INDEX recall requires stable paths)")
    if path.name == "README.md":
        errors.append("README.md is routing documentation, not a memory entry")

    if zone == "personal":
        if len(parts) not in {2, 3}:
            errors.append("personal memories must be layer/file.md or layer/category/file.md")
        elif len(parts) == 3 and parts[1] not in ALLOWED_SUBDIRS.get(layer, set()):
            errors.append(f"unapproved subdirectory {parts[1]!r} for layer {layer!r}")
    else:
        if any(ch.isspace() for ch in project):
            errors.append("project directory names must not contain whitespace")
        if len(parts) not in {3, 4}:
            errors.append("project memories must be projects/<name>/file.md or projects/<name>/<category>/file.md")
        elif len(parts) == 4 and parts[2] not in PROJECT_CATEGORIES:
            errors.append(
                f"unapproved project category {parts[2]!r} (expected one of {sorted(PROJECT_CATEGORIES)})"
            )

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return None, errors + [f"cannot read UTF-8 text: {exc}"]
    try:
        metadata, body = parse_frontmatter(text)
    except FrontmatterError as exc:
        return None, errors + [str(exc)]

    missing = sorted(REQUIRED_FIELDS - metadata.keys())
    unknown = sorted(metadata.keys() - ALLOWED_FIELDS)
    if missing:
        errors.append("missing fields: " + ", ".join(missing))
    if unknown:
        errors.append("unknown fields: " + ", ".join(unknown))

    memory_type = metadata.get("type")
    if zone == "personal":
        if memory_type not in TYPE_BY_LAYER.get(layer, set()):
            expected = ", ".join(sorted(TYPE_BY_LAYER.get(layer, set()))) or "none"
            errors.append(f"type {memory_type!r} does not match {layer}/ (expected: {expected})")
        if metadata.get("scope") == "project":
            errors.append("personal-zone memory must not use scope: project; move it to projects/<name>/")
    else:
        if memory_type not in PROJECT_TYPES:
            errors.append(
                f"type {memory_type!r} is not a project type (expected one of {sorted(PROJECT_TYPES)})"
            )
        elif len(parts) == 4 and memory_type not in TYPE_BY_PROJECT_CATEGORY[parts[2]]:
            expected = ", ".join(sorted(TYPE_BY_PROJECT_CATEGORY[parts[2]]))
            errors.append(f"type {memory_type!r} does not match category {parts[2]!r} (expected: {expected})")
        if metadata.get("scope") != "project":
            errors.append("project-zone memory must set scope: project")
        if memory_type == "Handoff" and not _valid_date(metadata.get("expires")):
            errors.append("Handoff memories must set a valid expires date")

    for field in ("title", "description"):
        value = metadata.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{field} must be a non-empty string")
        elif "\n" in value:
            errors.append(f"{field} must be a single line")
    if metadata.get("status") not in STATUSES:
        errors.append(f"status must be one of {sorted(STATUSES)}")
    if metadata.get("privacy") not in PRIVACY:
        errors.append(f"privacy must be one of {sorted(PRIVACY)}")
    tags = metadata.get("tags")
    if not isinstance(tags, list) or not tags or any(not isinstance(t, str) or not t.strip() for t in tags):
        errors.append("tags must be a non-empty inline list of strings")
    elif len({t.casefold() for t in tags}) != len(tags):
        errors.append("tags must not contain duplicates")
    if not _valid_date(metadata.get("timestamp")):
        errors.append("timestamp must be a valid YYYY-MM-DD date")
    if metadata.get("reviewed") is not True:
        errors.append("reviewed must be true for formal memory")
    if "scope" in metadata and metadata["scope"] not in SCOPES:
        errors.append(f"scope must be one of {sorted(SCOPES)}")
    if "source" in metadata and metadata["source"] not in SOURCES:
        errors.append(f"source must be one of {sorted(SOURCES)}")
    if metadata.get("expires") is not None and not _valid_date(metadata.get("expires")):
        errors.append("expires must be null or a valid YYYY-MM-DD date")
    supersedes = metadata.get("supersedes")
    if supersedes is not None:
        if not isinstance(supersedes, str) or not supersedes.endswith(".md"):
            errors.append("supersedes must be null or a repository-relative .md path")
        elif Path(supersedes).is_absolute() or ".." in Path(supersedes).parts:
            errors.append("supersedes must not be absolute or contain ..")
    if not body:
        errors.append("memory body must not be empty")

    return MemoryRecord(path, rel, zone, project, metadata, body), errors


# --- Path iterators ---

def iter_personal_paths(root: Path = ROOT) -> Iterable[Path]:
    for layer in LAYERS:
        base = root / layer
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.md")):
            if path.name != "README.md":
                yield path


def project_names(root: Path = ROOT) -> list[str]:
    base = root / PROJECTS_DIR
    if not base.is_dir():
        return []
    return sorted(
        entry.name for entry in base.iterdir() if entry.is_dir() and not entry.is_symlink()
    )


def iter_project_paths(root: Path = ROOT, name: str | None = None) -> Iterable[Path]:
    names = [name] if name else project_names(root)
    for project_name in names:
        base = root / PROJECTS_DIR / project_name
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.md")):
            if path.name not in {"README.md", "INDEX.md"}:
                yield path


def iter_memory_paths(root: Path = ROOT) -> Iterable[Path]:
    yield from iter_personal_paths(root)
    yield from iter_project_paths(root)


# --- Index rendering ---

def _entry_lines(active: list[MemoryRecord]) -> list[str]:
    lines = []
    for record in active:
        meta = record.metadata
        tags = ", ".join(meta["tags"])
        lines.append(
            f"- [{meta['type']}] {meta['title']} — {meta['description']} — tags: {tags} — {record.relative_path}"
        )
    return lines


def render_index(
    records: Iterable[MemoryRecord],
    *,
    title: str = "Memory Index",
    note: str = "仅列出 `status: active` 的正式记忆。",
    empty_note: str = "_当前没有已批准的正式记忆。_",
) -> str:
    active = sorted(
        (r for r in records if r.metadata.get("status") == "active"),
        key=lambda r: (r.relative_path.split("/", 1)[0], r.metadata["title"].casefold(), r.relative_path),
    )
    lines = [f"# {title}", "", f"> 自动生成；请勿手工编辑。{note}", ""]
    if not active:
        lines.append(empty_note)
    else:
        lines.extend(_entry_lines(active))
    return "\n".join(lines) + "\n"


def render_personal_index(records: Iterable[MemoryRecord]) -> str:
    return render_index(
        (r for r in records if r.zone == "personal"),
        note="仅列出个人区 `status: active` 的正式记忆。",
    )


def render_project_index(records: Iterable[MemoryRecord], name: str) -> str:
    return render_index(
        (r for r in records if r.zone == "project" and r.project == name),
        title=f"{name} 项目记忆索引",
        note=f"仅列出项目 `{name}` 中 `status: active` 的记忆。",
        empty_note="_该项目暂无已批准的记忆。_",
    )


def expected_indexes(root: Path, records: Iterable[MemoryRecord]) -> dict[Path, str]:
    records = list(records)
    result = {root / "INDEX.md": render_personal_index(records)}
    for name in project_names(root):
        result[root / PROJECTS_DIR / name / "INDEX.md"] = render_project_index(records, name)
    return result
