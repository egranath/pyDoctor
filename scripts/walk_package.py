#!/usr/bin/env python3
"""Build a PackageCache JSON by importing a package and walking public members.

Used for libraries with no Sphinx objects.inv (e.g. pyperclip), and as the
user-facing exporter:

    import os, sys
    sys.path.append('path_to_script')
    from walk_package import walk_package
    walk_package(PACKAGE)

PACKAGE may be a name string (``"bleach"``) or the imported module.

CLI (stdout JSON when outfile is omitted — ingest-defaults depends on this):

    python walk_package.py bleach
    python walk_package.py bleach bleach.json
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import pkgutil
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

__all__ = ["walk_package"]

_CONSTANT_TYPES = (int, float, complex, str, bytes, bool, type(None), tuple, frozenset)

KIND_MODULE = "module"
KIND_PACKAGE = "package"
KIND_CLASS = "class"
KIND_FUNCTION = "function"
KIND_METHOD = "method"
KIND_PROPERTY = "property"
KIND_CONSTANT = "constant"
KIND_VARIABLE = "variable"


def doc_summary(doc: str) -> str:
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


def kind_of(obj: Any, *, on_class: bool = False, is_property: bool = False) -> str:
    if is_property:
        return KIND_PROPERTY
    if inspect.ismodule(obj):
        return KIND_PACKAGE if hasattr(obj, "__path__") else KIND_MODULE
    if inspect.isclass(obj):
        return KIND_CLASS
    if inspect.isroutine(obj) or (callable(obj) and not inspect.isclass(obj)):
        return KIND_METHOD if on_class else KIND_FUNCTION
    if isinstance(obj, _CONSTANT_TYPES):
        return KIND_CONSTANT
    return KIND_VARIABLE


def same_family(val_mod: str | None, root: str) -> bool:
    if not val_mod:
        return False
    return val_mod == root or val_mod.startswith(root + ".")


def make_entry(
    path: str,
    kind: str,
    obj: Any,
    *,
    on_class: bool = False,
    is_property: bool = False,
) -> dict[str, Any]:
    name = path.rsplit(".", 1)[-1]
    doc = ""
    if inspect.ismodule(obj) or inspect.isclass(obj) or inspect.isroutine(obj) or isinstance(obj, property):
        try:
            doc = inspect.getdoc(obj) or ""
        except Exception:
            doc = ""
    sig = None
    if kind in (KIND_FUNCTION, KIND_METHOD, KIND_CLASS):
        sig = signature_str(obj)
    entry: dict[str, Any] = {
        "path": path,
        "kind": kind_of(obj, on_class=on_class, is_property=is_property) if kind != KIND_PACKAGE else KIND_PACKAGE,
        "dispname": name,
        "docUri": None,
        "signature": sig,
    }
    if kind == KIND_PACKAGE:
        entry["kind"] = KIND_PACKAGE
    if doc:
        entry["doc"] = doc
        entry["doc_summary"] = doc_summary(doc)
    return entry


def iter_submodules(root: str) -> list[str]:
    names = [root]
    try:
        pkg = importlib.import_module(root)
    except Exception:
        return names
    paths = getattr(pkg, "__path__", None)
    if not paths:
        return names

    skip_leaves = {"this", "conftest", "tests", "test"}

    def walk(mod_paths: Any, prefix: str) -> None:
        try:
            found = list(pkgutil.iter_modules(mod_paths, prefix))
        except Exception:
            return
        for _importer, modname, ispkg in found:
            leaf = modname.rsplit(".", 1)[-1]
            if leaf.startswith("_") or leaf in skip_leaves:
                continue
            names.append(modname)
            if not ispkg:
                continue
            try:
                child = importlib.import_module(modname)
            except BaseException as exc:
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                continue
            child_paths = getattr(child, "__path__", None)
            if child_paths:
                walk(child_paths, modname + ".")

    try:
        walk(paths, root + ".")
    except Exception:
        pass
    return names


def attr_names(obj: Any, *, include_private: bool) -> list[str]:
    try:
        names = list(dir(obj))
    except Exception:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        if not name or name in seen:
            continue
        if not include_private and name.startswith("_"):
            continue
        seen.add(name)
        out.append(name)
    return out


def public_names(obj: Any) -> list[str]:
    return attr_names(obj, include_private=False)


def canonical_path(obj: Any) -> str | None:
    try:
        if inspect.ismodule(obj):
            name = getattr(obj, "__name__", None)
            return name if isinstance(name, str) and name else None
        mod = getattr(obj, "__module__", None)
        qn = getattr(obj, "__qualname__", None)
        if isinstance(mod, str) and isinstance(qn, str) and mod and qn and "<locals>" not in qn:
            return f"{mod}.{qn}"
    except Exception:
        return None
    return None


def promote_modules_to_packages(entries: list[dict[str, Any]]) -> None:
    child_kinds: dict[str, set[str]] = {}
    for entry in entries:
        path = entry.get("path")
        if not isinstance(path, str) or "." not in path:
            continue
        parent = path.rsplit(".", 1)[0]
        child_kinds.setdefault(parent, set()).add(str(entry.get("kind")))
    for entry in entries:
        if entry.get("kind") != KIND_MODULE:
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            continue
        kids = child_kinds.get(path, set())
        if KIND_MODULE in kids or KIND_PACKAGE in kids:
            entry["kind"] = KIND_PACKAGE


SKIP_WALK_ROOTS = {
    "antigravity",
    "this",
    "turtle",
    "turtledemo",
    "idlelib",
    "test",
}


def merge_into_cache(cache: dict[str, Any]) -> int:
    """Add dir()/pkgutil access paths missing from a Sphinx inventory cache.

    Returns the number of entries appended.
    """
    name = cache.get("package")
    entries = cache.get("entries")
    if not isinstance(name, str) or not name or not isinstance(entries, list):
        return 0
    if name in SKIP_WALK_ROOTS:
        return 0

    warnings.filterwarnings("ignore")
    try:
        importlib.import_module(name)
    except Exception:
        return 0

    existing: dict[str, dict[str, Any]] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if isinstance(path, str) and path not in existing:
            existing[path] = item

    added = 0

    def add_entry(entry: dict[str, Any]) -> bool:
        nonlocal added
        path = entry.get("path")
        if not isinstance(path, str) or path in existing:
            return False
        existing[path] = entry
        entries.append(entry)
        added += 1
        return True

    def add_obj(path: str, obj: Any, *, on_class: bool, is_property: bool) -> dict[str, Any] | None:
        if path in existing:
            return None
        try:
            kind = kind_of(obj, on_class=on_class, is_property=is_property)
            if kind == KIND_PACKAGE and not hasattr(obj, "__path__"):
                kind = KIND_MODULE
            canon = canonical_path(obj)
            if canon and canon in existing and canon != path:
                src = existing[canon]
                entry = {
                    "path": path,
                    "kind": kind,
                    "dispname": path.rsplit(".", 1)[-1],
                    "docUri": src.get("docUri"),
                    "aliasOf": src.get("aliasOf") or canon,
                }
                if src.get("doc"):
                    entry["doc"] = src["doc"]
                if src.get("doc_summary"):
                    entry["doc_summary"] = src["doc_summary"]
                if src.get("signature"):
                    entry["signature"] = src["signature"]
                add_entry(entry)
                return entry
            entry = make_entry(path, kind, obj, on_class=on_class, is_property=is_property)
            add_entry(entry)
            return entry
        except Exception:
            return None

    def add_class_members(path: str, cls: Any, *, depth: int = 0) -> None:
        if depth > 3:
            return
        try:
            if not inspect.isclass(cls) or inspect.ismodule(cls):
                return
        except Exception:
            return
        for member in attr_names(cls, include_private=True):
            try:
                mval = getattr(cls, member)
            except Exception:
                continue
            try:
                if inspect.ismethoddescriptor(mval) or inspect.isgetsetdescriptor(mval) or inspect.isbuiltin(mval):
                    continue
                mmod = getattr(mval, "__module__", None)
                if mmod == "builtins":
                    continue
            except Exception:
                continue
            try:
                mstatic = inspect.getattr_static(cls, member)
            except AttributeError:
                mstatic = None
            mprop = isinstance(mstatic, property)
            try:
                if not mprop and mmod and not same_family(mmod, name):
                    if not member.startswith("_"):
                        continue
            except Exception:
                continue
            child_path = f"{path}.{member}"
            add_obj(child_path, mval, on_class=True, is_property=mprop)
            try:
                nested = inspect.isclass(mval) and not inspect.ismodule(mval)
            except Exception:
                nested = False
            if nested:
                add_class_members(child_path, mval, depth=depth + 1)

    for mod_name in iter_submodules(name):
        try:
            mod = importlib.import_module(mod_name)
        except BaseException as exc:
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            continue
        if mod_name != name:
            kind = KIND_PACKAGE if hasattr(mod, "__path__") else KIND_MODULE
            add_obj(mod_name, mod, on_class=False, is_property=False)
            node = existing.get(mod_name)
            if node and kind == KIND_PACKAGE:
                node["kind"] = KIND_PACKAGE
        for attr in attr_names(mod, include_private=True):
            try:
                val = getattr(mod, attr)
            except Exception:
                continue
            try:
                val_mod = getattr(val, "__module__", None)
                if inspect.ismodule(val):
                    val_mod = getattr(val, "__name__", None)
                    if not same_family(val_mod, name):
                        continue
                elif not attr.startswith("_") and val_mod and not same_family(val_mod, name):
                    continue
            except Exception:
                continue
            path = f"{mod_name}.{attr}"
            try:
                static_val = inspect.getattr_static(mod, attr)
            except AttributeError:
                static_val = None
            is_prop = isinstance(static_val, property)
            added_entry = add_obj(path, val, on_class=False, is_property=is_prop)
            try:
                is_cls = inspect.isclass(val) and not inspect.ismodule(val)
            except Exception:
                is_cls = False
            if is_cls:
                node = added_entry or existing.get(path)
                # Re-export aliases inherit methods via aliasOf; walk members on the
                # canonical / first-seen class path so class pages stay complete.
                if not (isinstance(node, dict) and node.get("aliasOf")):
                    add_class_members(path, val)

    promote_modules_to_packages(entries)
    return added


def _resolve_package(package: str | ModuleType) -> tuple[str, Any]:
    if isinstance(package, ModuleType):
        return package.__name__, package
    return package, importlib.import_module(package)


def _build_cache(package: str | ModuleType) -> dict[str, Any]:
    warnings.filterwarnings("ignore")
    name, root_obj = _resolve_package(package)
    seen: set[str] = set()
    entries: list[dict[str, Any]] = []

    def add(entry: dict[str, Any]) -> None:
        path = entry["path"]
        if path in seen:
            return
        seen.add(path)
        entries.append(entry)

    add(make_entry(name, KIND_PACKAGE, root_obj))

    for mod_name in iter_submodules(name):
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            continue
        if mod_name != name:
            kind = KIND_PACKAGE if hasattr(mod, "__path__") else KIND_MODULE
            add(make_entry(mod_name, kind, mod))
        for attr in public_names(mod):
            try:
                val = getattr(mod, attr)
            except Exception:
                continue
            val_mod = getattr(val, "__module__", None)
            if inspect.ismodule(val):
                val_mod = getattr(val, "__name__", None)
                if not same_family(val_mod, name):
                    continue
            elif val_mod and not same_family(val_mod, name):
                continue
            path = f"{mod_name}.{attr}"
            try:
                static_val = inspect.getattr_static(mod, attr)
            except AttributeError:
                static_val = None
            is_prop = isinstance(static_val, property)
            kind = kind_of(val, is_property=is_prop)
            add(make_entry(path, kind, val, is_property=is_prop))
            if not inspect.isclass(val) or inspect.ismodule(val):
                continue
            for member in public_names(val):
                try:
                    mval = getattr(val, member)
                except Exception:
                    continue
                if inspect.ismethoddescriptor(mval) or inspect.isgetsetdescriptor(mval) or inspect.isbuiltin(mval):
                    continue
                mmod = getattr(mval, "__module__", None)
                if mmod == "builtins":
                    continue
                try:
                    mstatic = inspect.getattr_static(val, member)
                except AttributeError:
                    mstatic = None
                mprop = isinstance(mstatic, property)
                if not mprop and mmod and not same_family(mmod, name):
                    continue
                mpath = f"{path}.{member}"
                add(
                    make_entry(
                        mpath,
                        kind_of(mval, on_class=True, is_property=mprop),
                        mval,
                        on_class=True,
                        is_property=mprop,
                    )
                )

    return {
        "package": name,
        "sourceUrl": f"walk:{name}",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "entries": entries,
    }


def walk_package(package: str | ModuleType, outfile: str | Path | None = None) -> str:
    cache = _build_cache(package)
    name = cache["package"]
    dest = Path(outfile) if outfile is not None else Path(os.getcwd()) / f"{name}.json"
    dest.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return f"Saved {dest.name} to {os.getcwd()}"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: walk_package.py <package> [outfile]", file=sys.stderr)
        return 2
    name = sys.argv[1].strip()
    if len(sys.argv) >= 3:
        print(walk_package(name, sys.argv[2]), file=sys.stderr)
        return 0
    cache = _build_cache(name)
    sys.stdout.write(json.dumps(cache, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
