#!/usr/bin/env python3
"""Fill doc / doc_summary / signature on pyDoctor cache JSON.

Prefers inspect.getdoc / inspect.signature when the package imports.
Falls back to ingest-time Sphinx HTML scrape (unique page URL, not per object).
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any

from scrape_docs import fill_missing_from_html

SKIP_ROOTS = {
    "antigravity",
    "this",
    "turtle",
    "turtledemo",
    "idlelib",
    "test",
}

resolved: dict[str, Any] = {}


def doc_summary(doc: str) -> str:
    """First paragraph of a docstring, up to 400 chars."""
    lines: list[str] = []
    for line in doc.strip().splitlines():
        stripped = line.strip()
        if not stripped:
            if lines:
                break
            continue
        if all(c in "=-~#^*+`" for c in stripped):
            if lines:
                break
            continue
        lines.append(stripped)
    result = " ".join(lines)
    if len(result) > 400:
        result = result[:397] + "…"
    return result


def signature_str(obj: Any) -> str | None:
    try:
        return str(inspect.signature(obj))
    except (TypeError, ValueError):
        return "(...)" if callable(obj) else None


_MISSING = object()


def resolve_path(path: str) -> Any | None:
    if path in resolved:
        return resolved[path]
    parts = path.split(".")
    if parts[0] in SKIP_ROOTS:
        resolved[path] = None
        return None

    obj: Any | None = None
    used = 0
    for i in range(len(parts), 0, -1):
        prefix = ".".join(parts[:i])
        cached = resolved.get(prefix, _MISSING)
        if cached is not _MISSING:
            obj = cached
            used = i
            break
        try:
            obj = importlib.import_module(prefix)
            resolved[prefix] = obj
            used = i
            break
        except Exception:
            continue
    if obj is None:
        resolved[path] = None
        return None
    try:
        for j, attr in enumerate(parts[used:], used):
            obj = getattr(obj, attr)
            resolved[".".join(parts[: j + 1])] = obj
    except Exception:
        resolved[path] = None
        return None
    return obj


def enrich_entries(entries: list[dict[str, Any]]) -> tuple[int, int]:
    filled_doc = 0
    filled_sig = 0
    for entry in entries:
        path = entry.get("path")
        if not isinstance(path, str) or not path:
            continue
        obj = resolve_path(path)
        if obj is None:
            continue
        try:
            doc = inspect.getdoc(obj) or ""
        except Exception:
            doc = ""
        if doc:
            entry["doc"] = doc
            entry["doc_summary"] = doc_summary(doc)
            filled_doc += 1
        try:
            is_mod = inspect.ismodule(obj)
            is_cls = inspect.isclass(obj)
            is_callable = (inspect.isroutine(obj) or callable(obj)) and not is_cls and not is_mod
            if is_callable or is_cls:
                sig = signature_str(obj)
                if sig:
                    entry["signature"] = sig
                    filled_sig += 1
        except Exception:
            pass
    return filled_doc, filled_sig


def enrich_package(cache: dict[str, Any]) -> tuple[int, int, int]:
    entries = cache.get("entries")
    if not isinstance(entries, list):
        return 0, 0, 0
    root = cache.get("package")
    if isinstance(root, str) and root in SKIP_ROOTS:
        return 0, 0, len(entries)
    docs, sigs = enrich_entries(entries)
    scrape_limit = 2500
    if len(entries) > scrape_limit and os.environ.get("DOCS_BROWSER_FORCE_SCRAPE") != "1":
        print(f"    skipping HTML scrape for {root} ({len(entries)} entries)")
        return docs, 0, len(entries)
    scraped = fill_missing_from_html(entries)
    return docs, scraped, len(entries)


def enrich_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and data.get("shards"):
        print(f"  {path.name}: skipped (sharded root)")
        return
    if isinstance(data, dict) and isinstance(data.get("packages"), list):
        filled = 0
        scraped = 0
        total = 0
        for pkg in data["packages"]:
            if not isinstance(pkg, dict):
                continue
            d, s, t = enrich_package(pkg)
            filled += d
            scraped += s
            total += t
        print(f"  {path.name}: {filled}/{total} inspect docs, {scraped} scraped")
    elif isinstance(data, dict) and isinstance(data.get("entries"), list):
        filled, scraped, total = enrich_package(data)
        print(f"  {path.name}: {filled}/{total} inspect docs, {scraped} scraped")
    else:
        print(f"  {path.name}: skipped (unrecognized schema)")
        return
    path.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: enrich_docs.py <cache-dir>", file=sys.stderr)
        return 2
    cache_dir = Path(sys.argv[1])
    skip = {"index.json", "catalog-top.json", "pypi-index.json"}
    named = [Path(arg) if Path(arg).is_absolute() else cache_dir / arg for arg in sys.argv[2:]]
    files = named or sorted(
        path for path in cache_dir.glob("*.json") if path.name not in skip
    )
    warnings.filterwarnings("ignore")
    os.environ.setdefault("MPLBACKEND", "Agg")
    print("Enriching cache docstrings…")
    for file in files:
        enrich_file(file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
