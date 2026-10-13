#!/usr/bin/env python3
"""Ingest-time Sphinx HTML scrape. Not used in the browser."""

from __future__ import annotations

import os
import html as html_lib
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag
from urllib.request import Request, urlopen

USER_AGENT = "docs-browser-ingest/1.0"
FETCH_TIMEOUT = 25
MAX_WORKERS = 8
MAX_PAGES = 4000


def summarize_doc(doc: str) -> str:
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

_SKIP_TAGS = frozenset({"script", "style", "noscript"})
_SKIP_LINK_CLASS = frozenset({"viewcode-link", "headerlink", "header-link"})


class SphinxAutodocParser(HTMLParser):
    """Collect dt[id]/dd text and signatures; also record other element ids."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.docs: dict[str, str] = {}
        self.sigs: dict[str, str] = {}
        self._in_dt = False
        self._dt_id: str | None = None
        self._dt_parts: list[str] = []
        self._pending_id: str | None = None
        self._dd_stack: list[dict[str, Any]] = []
        self._skip_depth = 0
        self._skip_link_depth = 0
        self._section_id: str | None = None
        self._section_parts: list[str] = []
        self._section_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k: (v or "") for k, v in attrs}
        classes = set((ad.get("class") or "").split())
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "a" and classes & _SKIP_LINK_CLASS:
            self._skip_link_depth += 1
            return
        el_id = ad.get("id") or ""
        if tag == "dt" and el_id:
            self._in_dt = True
            self._dt_id = el_id
            self._dt_parts = []
        elif tag == "dd" and self._pending_id:
            self._dd_stack.append({"id": self._pending_id, "parts": [], "nest": 0})
            self._pending_id = None
        elif tag == "dl" and self._dd_stack:
            self._dd_stack[-1]["nest"] += 1
        elif tag in ("section", "div") and el_id and not self._section_id:
            self._section_id = el_id
            self._section_parts = []
            self._section_depth = 1
        elif self._section_id and tag in ("section", "div"):
            self._section_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "a" and self._skip_link_depth:
            self._skip_link_depth -= 1
            return
        if tag == "dt" and self._in_dt:
            self._in_dt = False
            sig = _sig_from_dt("".join(self._dt_parts))
            if self._dt_id and sig:
                self.sigs[self._dt_id] = sig
            self._pending_id = self._dt_id
            self._dt_id = None
        elif tag == "dl" and self._dd_stack:
            nest = int(self._dd_stack[-1]["nest"])
            self._dd_stack[-1]["nest"] = max(0, nest - 1)
        elif tag == "dd" and self._dd_stack:
            frame = self._dd_stack.pop()
            text = _normalize_text("".join(frame["parts"]))
            if text:
                self.docs[str(frame["id"])] = text
        elif self._section_id and tag in ("section", "div"):
            self._section_depth -= 1
            if self._section_depth <= 0:
                text = _normalize_text("".join(self._section_parts))
                if text and self._section_id not in self.docs:
                    self.docs[self._section_id] = text
                self._section_id = None
                self._section_parts = []
                self._section_depth = 0

    def handle_data(self, data: str) -> None:
        if self._skip_depth or self._skip_link_depth:
            return
        if self._in_dt:
            self._dt_parts.append(data)
            return
        if self._dd_stack and int(self._dd_stack[-1]["nest"]) == 0:
            self._dd_stack[-1]["parts"].append(data)
            return
        if self._section_id and not self._dd_stack and not self._in_dt:
            self._section_parts.append(data)


def _sig_from_dt(text: str) -> str | None:
    cleaned = (
        text.replace("[source]", "")
        .replace("¶", "")
        .replace("\xa0", " ")
        .strip()
    )
    cleaned = re.sub(r"\s+", " ", cleaned)
    start = cleaned.find("(")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(cleaned[start:], start):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return cleaned[start : i + 1]
    return None


def _normalize_text(text: str) -> str:
    text = html_lib.unescape(text)
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).rstrip() for line in text.splitlines()]
    collapsed: list[str] = []
    blank = False
    for line in lines:
        if not line.strip():
            if collapsed and not blank:
                collapsed.append("")
            blank = True
            continue
        blank = False
        collapsed.append(line.strip())
    return "\n".join(collapsed).strip()


def parse_sphinx_html(html: str) -> tuple[dict[str, str], dict[str, str]]:
    parser = SphinxAutodocParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass
    return parser.docs, parser.sigs


def fetch_html(url: str) -> str | None:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    try:
        with urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
            charset = "utf-8"
            ctype = resp.headers.get_content_charset()
            if ctype:
                charset = ctype
            return raw.decode(charset, errors="replace")
    except (HTTPError, URLError, TimeoutError, OSError):
        return None


def _page_url(doc_uri: str) -> str:
    base, _frag = urldefrag(doc_uri)
    return base


def _lookup_keys(path: str, doc_uri: str | None) -> list[str]:
    keys: list[str] = []
    if doc_uri:
        _base, frag = urldefrag(doc_uri)
        if frag:
            keys.append(frag)
    keys.append(path)
    keys.append(f"module-{path}")
    leaf = path.rsplit(".", 1)[-1]
    if leaf and leaf != path:
        keys.append(leaf)
    seen: set[str] = set()
    out: list[str] = []
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def fill_missing_from_html(entries: list[dict[str, Any]]) -> int:
    """Fetch each unique docUri page once and fill missing doc / signature."""
    if os.environ.get("DOCS_BROWSER_SKIP_SCRAPE") == "1":
        return 0
    by_page: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("doc"):
            continue
        uri = entry.get("docUri")
        if not isinstance(uri, str) or not uri.startswith("http"):
            continue
        page = _page_url(uri)
        if not page:
            continue
        by_page.setdefault(page, []).append(entry)

    pages = list(by_page.keys())[:MAX_PAGES]
    if not pages:
        return 0

    fetched: dict[str, tuple[dict[str, str], dict[str, str]]] = {}
    verbose = len(pages) >= 10
    if verbose:
        print(f"    scraping {len(pages)} unique HTML pages…")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(fetch_html, url): url for url in pages}
        done = 0
        for fut in as_completed(futs):
            url = futs[fut]
            done += 1
            html = None
            try:
                html = fut.result()
            except Exception:
                html = None
            if html:
                fetched[url] = parse_sphinx_html(html)
            if verbose and (done % 50 == 0 or done == len(pages)):
                print(f"    scraped {done}/{len(pages)} pages")

    filled = 0
    for page, group in by_page.items():
        parsed = fetched.get(page)
        if not parsed:
            continue
        docs, sigs = parsed
        for entry in group:
            path = entry.get("path")
            if not isinstance(path, str):
                continue
            uri = entry.get("docUri")
            uri_s = uri if isinstance(uri, str) else None
            keys = _lookup_keys(path, uri_s)
            if not entry.get("doc"):
                for key in keys:
                    doc = docs.get(key)
                    if doc:
                        entry["doc"] = doc
                        entry["doc_summary"] = summarize_doc(doc)
                        filled += 1
                        break
            if not entry.get("signature"):
                for key in keys:
                    sig = sigs.get(key)
                    if sig:
                        entry["signature"] = sig
                        break
    return filled
