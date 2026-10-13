#!/usr/bin/env python3
"""Merge import-path members (dir / pkgutil) into Sphinx inventory caches.

Sphinx inventories often store objects at their canonical module path
(`sympy.functions.elementary.trigonometric.sin`) and omit the re-exported
access path (`sympy.sin`). The browser lists only direct children, so package
roots look empty. This ingest-time walk bakes those access paths into the JSON.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path

from walk_package import merge_into_cache


def merge_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and data.get("shards"):
        print(f"  {path.name}: skipped (sharded root)")
        return
    if isinstance(data, dict) and isinstance(data.get("packages"), list):
        added = 0
        total = 0
        for pkg in data["packages"]:
            if not isinstance(pkg, dict):
                continue
            total += 1
            n = merge_into_cache(pkg)
            added += n
            if n:
                print(f"    {pkg.get('package')}: +{n}")
        print(f"  {path.name}: added {added} across {total} packages")
    elif isinstance(data, dict) and isinstance(data.get("entries"), list):
        n = merge_into_cache(data)
        print(f"  {path.name}: +{n} (now {len(data['entries'])} entries)")
    else:
        print(f"  {path.name}: skipped (unrecognized schema)")
        return
    path.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: merge_walk.py <cache-dir> [file.json ...]", file=sys.stderr)
        return 2
    cache_dir = Path(sys.argv[1])
    skip = {"index.json", "catalog-top.json", "pypi-index.json"}
    named = [Path(arg) if Path(arg).is_absolute() else cache_dir / arg for arg in sys.argv[2:]]
    files = named or sorted(
        path for path in cache_dir.glob("*.json") if path.name not in skip
    )
    warnings.filterwarnings("ignore")
    os.environ.setdefault("MPLBACKEND", "Agg")
    print("Merging import-path members into caches…")
    for file in files:
        try:
            merge_file(file)
        except Exception as exc:
            print(f"  {file.name}: failed ({exc})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
