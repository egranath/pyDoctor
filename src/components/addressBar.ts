import { search, fetchObjectByPath, lookupPypi, ApiRequestError } from '../api';
import { store } from '../cache/store';
import { iconEl } from '../icons';
import { hrefFor } from '../router';
import type { ObjectDescription, PypiInfo, SearchResponse, SearchSuggestion } from '../types';
import { getShowUnloaded, setShowUnloaded, subscribeShowUnloaded } from '../unloadedPref';

export interface AddressBarHandle {
  element: HTMLDivElement;
  toggleBtn: HTMLButtonElement;
  setValue: (value: string) => void;
  focus: () => void;
}

interface AddressBarOptions {
  onResolved: (obj: ObjectDescription, accessPath: string) => void;
  onPypi: (info: PypiInfo) => void;
  onError: (message: string) => void;
}

type DropdownRow =
  | { kind: 'api'; suggestion: SearchSuggestion }
  | { kind: 'pypi'; info: PypiInfo };

let debounceTimer: number | undefined;
let searchSeq = 0;

export function createAddressBar(options: AddressBarOptions): AddressBarHandle {
  const wrap = document.createElement('div');
  wrap.className = 'oi-address-wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'oi-address-input';
  input.placeholder = 'Search a path or syntax (e.g. os.path.join or &)';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const suggestionsEl = document.createElement('div');
  suggestionsEl.className = 'oi-suggestions';
  suggestionsEl.style.display = 'none';

  wrap.append(input, suggestionsEl);

  let currentSuggestions: SearchSuggestion[] = [];
  let currentPypi: PypiInfo[] = [];
  let activeIndex = -1;
  const PAGE_SIZE = 20;
  let displayCount = PAGE_SIZE;
  let abort: AbortController | undefined;

  let showUnloaded = getShowUnloaded();

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'oi-nav-btn' + (showUnloaded ? ' oi-nav-btn--active' : '');
  toggleBtn.title = showUnloaded ? 'Hide unloaded packages' : 'Show unloaded packages';
  const toggleIco = document.createElement('span');
  toggleIco.className = 'codicon codicon-package';
  toggleBtn.appendChild(toggleIco);

  function applyToggleUi(): void {
    toggleBtn.className = 'oi-nav-btn' + (showUnloaded ? ' oi-nav-btn--active' : '');
    toggleBtn.title = showUnloaded ? 'Hide unloaded packages' : 'Show unloaded packages';
  }

  function applyResponse(res: SearchResponse, reset: boolean): void {
    currentSuggestions = res.suggestions;
    currentPypi = res.pypi ?? [];
    if (reset) {
      activeIndex = -1;
      displayCount = PAGE_SIZE;
    } else {
      const total = visibleRows().length;
      if (activeIndex >= total) activeIndex = total ? total - 1 : -1;
    }
    renderSuggestions();
  }

  async function runSearch(value: string): Promise<void> {
    const seq = ++searchSeq;
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    let reset = true;
    const apply = (res: SearchResponse): void => {
      if (seq !== searchSeq) return;
      applyResponse(res, reset);
      reset = false;
    };
    const res = await search(value, 200, showUnloaded, apply, signal);
    if (seq !== searchSeq) return;
    apply(res);
  }

  subscribeShowUnloaded((next) => {
    showUnloaded = next;
    applyToggleUi();
    void runSearch(input.value);
  });
  store.subscribe(() => {
    if (!input.value.trim()) return;
    void runSearch(input.value);
  });

  toggleBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  toggleBtn.addEventListener('click', () => {
    setShowUnloaded(!getShowUnloaded());
    input.focus();
  });

  function visibleRows(): DropdownRow[] {
    const api = currentSuggestions.slice(0, displayCount).map((suggestion) => (
      { kind: 'api' as const, suggestion }
    ));
    const pypi = currentPypi.map((info) => ({ kind: 'pypi' as const, info }));
    return [...api, ...pypi];
  }

  function suggestionHref(s: SearchSuggestion): string {
    return hrefFor(s.package, s.path);
  }

  function expandIfScrolledToEnd(): void {
    if (suggestionsEl.style.display === 'none') return;
    const { scrollTop, scrollHeight, clientHeight } = suggestionsEl;
    if (scrollHeight - scrollTop - clientHeight > 48) return;
    if (displayCount >= currentSuggestions.length) return;
    displayCount = Math.min(displayCount + PAGE_SIZE, currentSuggestions.length);
    renderSuggestions();
  }

  function renderSuggestions(): void {
    const prevScroll = suggestionsEl.scrollTop;
    const show = document.activeElement === input || suggestionsEl.style.display !== 'none';
    suggestionsEl.innerHTML = '';
    const rows = visibleRows();

    if (rows.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }

    rows.forEach((row, i) => {
      if (row.kind === 'api') {
        const s = row.suggestion;
        const el = document.createElement('a');
        el.href = suggestionHref(s);
        el.className = 'oi-suggestion'
          + (s.unloaded ? ' oi-suggestion-unloaded' : '')
          + (s.manual ? ' oi-suggestion-manual' : '')
          + (i === activeIndex ? ' oi-suggestion-active' : '');
        el.appendChild(iconEl(s.kind, s.package));
        const pathSpan = document.createElement('span');
        pathSpan.className = 'oi-suggestion-path';
        pathSpan.textContent = s.signature ? `${s.path}${s.signature}` : s.path;
        const doc = document.createElement('span');
        doc.className = 'oi-suggestion-doc';
        doc.textContent = s.doc_summary || '';
        el.append(pathSpan, doc);
        el.addEventListener('mousedown', (e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
        });
        el.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          chooseSuggestion(s);
        });
        suggestionsEl.appendChild(el);
        return;
      }

      const info = row.info;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'oi-suggestion oi-suggestion-pypi'
        + (i === activeIndex ? ' oi-suggestion-active' : '');
      const badge = document.createElement('span');
      badge.className = 'oi-pypi-badge';
      badge.textContent = 'PyPI';
      const pathSpan = document.createElement('span');
      pathSpan.className = 'oi-suggestion-path';
      pathSpan.textContent = info.version ? `${info.name} ${info.version}` : info.name;
      const doc = document.createElement('span');
      doc.className = 'oi-suggestion-doc';
      doc.textContent = info.summary || '';
      el.append(badge, pathSpan, doc);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choosePypi(info);
      });
      suggestionsEl.appendChild(el);
    });

    if (!show) return;
    suggestionsEl.style.display = 'block';
    suggestionsEl.scrollTop = prevScroll;
    expandIfScrolledToEnd();
  }

  suggestionsEl.addEventListener('scroll', () => expandIfScrolledToEnd(), { passive: true });

  function chooseSuggestion(s: SearchSuggestion): void {
    input.value = s.path;
    suggestionsEl.style.display = 'none';
    void resolve(s.path);
  }

  function choosePypi(info: PypiInfo): void {
    input.value = info.name;
    suggestionsEl.style.display = 'none';
    options.onPypi(info);
  }

  async function resolve(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const obj = await fetchObjectByPath(trimmed);
      options.onResolved(obj, obj.path);
    } catch (err) {
      const exact = currentPypi.find((row) => row.name.toLowerCase() === trimmed.toLowerCase());
      if (exact) {
        options.onPypi(exact);
        return;
      }
      try {
        const live = await lookupPypi(trimmed);
        if (live) {
          options.onPypi(live);
          return;
        }
      } catch {
        // fall through to the original error
      }
      const message = err instanceof ApiRequestError || err instanceof Error
        ? err.message
        : String(err);
      options.onError(message);
    }
  }

  input.addEventListener('input', () => {
    const value = input.value;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => { void runSearch(value); }, 120);
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const nav = visibleRows();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (nav.length) { activeIndex = (activeIndex + 1) % nav.length; renderSuggestions(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (nav.length) { activeIndex = (activeIndex - 1 + nav.length) % nav.length; renderSuggestions(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = activeIndex >= 0 ? nav[activeIndex] : undefined;
      if (row?.kind === 'api') {
        chooseSuggestion(row.suggestion);
      } else if (row?.kind === 'pypi') {
        choosePypi(row.info);
      } else {
        suggestionsEl.style.display = 'none';
        void resolve(input.value);
      }
    } else if (e.key === 'Escape') {
      suggestionsEl.style.display = 'none';
      activeIndex = -1;
    } else if (e.altKey && e.key === 'Backspace') {
      e.preventDefault();
      const val = input.value;
      const pos = input.selectionStart ?? val.length;
      const before = val.slice(0, pos);
      const lastDot = before.lastIndexOf('.');
      const newBefore = lastDot !== -1 ? before.slice(0, lastDot) : '';
      input.value = newBefore + val.slice(input.selectionEnd ?? pos);
      input.setSelectionRange(newBefore.length, newBefore.length);
      input.dispatchEvent(new Event('input'));
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      suggestionsEl.style.display = 'none';
    }, 100);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) void runSearch(input.value);
    else if (visibleRows().length) suggestionsEl.style.display = 'block';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  return {
    element: wrap,
    toggleBtn,
    setValue: (value: string) => { input.value = value; },
    focus: () => input.focus(),
  };
}
