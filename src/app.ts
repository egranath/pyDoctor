import { fetchObjectByPath, lookupPypi } from './api';
import { store } from './cache/store';
import { createAddressBar } from './components/addressBar';
import { renderMemberTable, type MemberTableHandle } from './components/memberTable';
import { renderFunctionView } from './components/functionView';
import { renderPypiCard } from './components/pypiCard';
import { createSidebar } from './components/sidebar';
import { iconEl } from './icons';
import { mountDocstring, remountDocstrings } from './highlight';
import { attachTooltip, hideTooltip } from './components/tooltip';
import { getDocMarkdown, setDocMarkdown, subscribeDocMarkdown } from './markdownPref';
import { setShowUnloaded } from './unloadedPref';
import {
  goBack,
  goForward,
  navigateToPath,
  navigateHome,
  onRouteChange,
  onNavStateChange,
  getNavState,
  parseCurrentRoute,
  persistViewState,
  readViewState,
  hrefFor,
  type ViewState,
} from './router';
import type { ObjectDescription, Kind, PypiInfo } from './types';
import { isSingleCharLabel } from './utils';

const NAMESPACE_KINDS = new Set(['module', 'package']);
const APP_BASE_TITLE = 'pyDoctor';

interface HistoryEntry {
  pkg: string;
  path: string;
  name: string;
  kind: Kind;
}

function setTitle(displayPath: string, lastLabel?: string): void {
  if (!displayPath) { document.title = APP_BASE_TITLE; return; }
  document.title = lastLabel || displayPath.split('.').at(-1) || APP_BASE_TITLE;
}

function makeMarkdownToggle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'oi-md-toggle';
  btn.title = 'Format docstrings as Markdown';
  btn.setAttribute('aria-pressed', getDocMarkdown() ? 'true' : 'false');
  const label = document.createElement('span');
  label.className = 'oi-md-toggle-label';
  label.textContent = 'Markdown';
  const track = document.createElement('span');
  track.className = 'oi-md-toggle-track';
  const knob = document.createElement('span');
  knob.className = 'oi-md-toggle-knob';
  track.appendChild(knob);
  btn.append(label, track);
  btn.addEventListener('click', () => {
    setDocMarkdown(btn.getAttribute('aria-pressed') !== 'true');
  });
  return btn;
}

function renderPathBar(
  fullPath: string,
  kind: Kind,
  pkg: string,
  onNav: (path: string) => void,
  truePath?: string,
  lastLabel?: string,
  trailing?: HTMLElement,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'oi-path-bar-wrap';

  const row = document.createElement('div');
  row.className = 'oi-path-bar-row';

  const bar = document.createElement('div');
  bar.className = 'oi-path-bar';
  const ico = iconEl(kind, pkg);
  ico.style.marginRight = '4px';
  bar.appendChild(ico);
  const parts = fullPath.split('.');

  parts.forEach((part, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'oi-path-sep';
      sep.textContent = '/';
      bar.appendChild(sep);
    }
    if (idx < parts.length - 1) {
      const segPath = parts.slice(0, idx + 1).join('.');
      const btn = document.createElement('a');
      btn.href = hrefFor(pkg, segPath);
      btn.className = 'oi-path-seg-btn' + (isSingleCharLabel(part) ? ' oi-char-hit' : '');
      btn.textContent = part;
      btn.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        onNav(segPath);
      });
      bar.appendChild(btn);
    } else {
      const cur = document.createElement('span');
      cur.className = 'oi-path-seg-current';
      cur.textContent = lastLabel || part;
      bar.appendChild(cur);
    }
  });
  row.appendChild(bar);
  if (trailing) row.appendChild(trailing);
  wrapper.appendChild(row);

  if (truePath && truePath !== fullPath) {
    const trueEl = document.createElement('div');
    trueEl.className = 'oi-true-path';
    const trueParts = truePath.split('.');
    trueParts.forEach((part, idx) => {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.textContent = '.';
        trueEl.appendChild(sep);
      }
      const segPath = trueParts.slice(0, idx + 1).join('.');
      if (idx < trueParts.length - 1) {
        const btn = document.createElement('a');
        btn.href = hrefFor(pkg, segPath);
        btn.className = 'oi-true-path-btn' + (isSingleCharLabel(part) ? ' oi-char-hit' : '');
        btn.textContent = part;
        btn.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onNav(segPath);
        });
        trueEl.appendChild(btn);
      } else {
        const cur = document.createElement('span');
        cur.className = 'oi-true-path-current';
        cur.textContent = part;
        trueEl.appendChild(cur);
      }
    });
    wrapper.appendChild(trueEl);
  }

  return wrapper;
}

function iconSpan(cls: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon ${cls}`;
  return span;
}

export async function initApp(root: HTMLElement): Promise<void> {
  root.innerHTML = '<div class="oi-loading">Loading\u2026</div>';
  await store.init();
  root.innerHTML = '';

  const historyEntries: HistoryEntry[] = [];
  try {
    const saved = localStorage.getItem('db_history');
    if (saved) {
      const parsed: HistoryEntry[] = JSON.parse(saved);
      if (Array.isArray(parsed)) historyEntries.push(...parsed.slice(-50));
    }
  } catch {}

  let historyDropdownVisible = false;
  let activePkg: string | undefined;

  let activePypi: PypiInfo | undefined;

  const sidebar = createSidebar({
    onOpenPackage: (name) => { void navigatePathAndRender(store.rootPath(name), name); },
    onPypi: (info) => showPypiCard(info),
    onError: (message) => renderError(message),
    onReset: () => { void resetToDefaults(); },
    getActivePackage: () => activePkg,
  });

  const main = document.createElement('div');
  main.className = 'oi-main';

  const toolbar = document.createElement('div');
  toolbar.className = 'oi-toolbar';

  const backBtn = document.createElement('button');
  backBtn.className = 'oi-nav-btn';
  backBtn.title = 'Back';
  backBtn.appendChild(iconSpan('codicon-arrow-left'));
  backBtn.addEventListener('click', () => {
    hideTooltip();
    closeHistoryDropdown();
    leaveCurrentView();
    goBack();
  });

  const fwdBtn = document.createElement('button');
  fwdBtn.className = 'oi-nav-btn';
  fwdBtn.title = 'Forward';
  fwdBtn.appendChild(iconSpan('codicon-arrow-right'));
  fwdBtn.addEventListener('click', () => {
    hideTooltip();
    closeHistoryDropdown();
    leaveCurrentView();
    goForward();
  });

  function updateNavButtons(): void {
    const { canGoBack, canGoForward } = getNavState();
    backBtn.disabled = !canGoBack;
    fwdBtn.disabled = !canGoForward;
  }
  onNavStateChange(updateNavButtons);
  updateNavButtons();

  const homeBtn = document.createElement('button');
  homeBtn.className = 'oi-nav-btn';
  homeBtn.title = 'Home';
  homeBtn.appendChild(iconSpan('codicon-home'));
  homeBtn.addEventListener('click', () => {
    hideTooltip();
    closeHistoryDropdown();
    const route = parseCurrentRoute();
    const home = preferredHome();
    if (home && route.kind === 'object' && route.pkg === home.pkg && route.path === home.path) {
      content.scrollTop = 0;
      return;
    }
    if (!home && route.kind === 'home') {
      content.scrollTop = 0;
      return;
    }
    leaveCurrentView();
    void openHome({ replace: false });
  });

  const histBtn = document.createElement('button');
  histBtn.className = 'oi-nav-btn';
  histBtn.title = 'History';
  histBtn.appendChild(iconSpan('codicon-history'));

  const histDropdown = document.createElement('div');
  histDropdown.className = 'oi-history-dropdown';
  histDropdown.style.display = 'none';

  const histWrap = document.createElement('div');
  histWrap.style.position = 'relative';
  histWrap.append(histBtn, histDropdown);

  histBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    historyDropdownVisible = !historyDropdownVisible;
    renderHistoryDropdown();
    histDropdown.style.display = historyDropdownVisible ? 'block' : 'none';
  });
  document.addEventListener('click', () => closeHistoryDropdown());

  function closeHistoryDropdown(): void {
    historyDropdownVisible = false;
    histDropdown.style.display = 'none';
  }

  function renderHistoryDropdown(): void {
    histDropdown.innerHTML = '';
    if (historyEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'oi-history-empty';
      empty.textContent = 'No history yet.';
      histDropdown.appendChild(empty);
      return;
    }
    for (let i = historyEntries.length - 1; i >= 0; i--) {
      const entry = historyEntries[i]!;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'oi-history-item';
      const ico = iconEl(entry.kind, entry.pkg);
      if (!ico.classList.contains('oi-icon-core')) ico.style.opacity = '0.55';
      item.append(ico, document.createTextNode(entry.path));
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeHistoryDropdown();
        void navigatePathAndRender(entry.path, entry.pkg);
      });
      histDropdown.appendChild(item);
    }
  }

  const addressBar = createAddressBar({
    onResolved: (obj, accessPath) => {
      leaveCurrentView();
      pushHistory(obj, accessPath);
      navigateToPath(obj.package, accessPath);
      renderObject(obj, accessPath);
      content.scrollTop = 0;
      thawViewPersist();
      updateNavButtons();
    },
    onPypi: (info) => showPypiCard(info),
    onError: (message) => renderError(message),
  });

  const toolbarFilterWrap = document.createElement('div');
  toolbarFilterWrap.className = 'oi-toolbar-filter-wrap';
  const filterIco = document.createElement('span');
  filterIco.className = 'codicon codicon-search oi-toolbar-filter-icon';
  const toolbarFilterInput = document.createElement('input');
  toolbarFilterInput.type = 'text';
  toolbarFilterInput.className = 'oi-toolbar-filter-input';
  toolbarFilterInput.placeholder = 'Filter';
  toolbarFilterInput.autocomplete = 'off';
  toolbarFilterInput.spellcheck = false;
  toolbarFilterWrap.append(filterIco, toolbarFilterInput);

  let activeMemberTable: MemberTableHandle | null = null;
  toolbarFilterInput.addEventListener('input', () => {
    activeMemberTable?.setFilter(toolbarFilterInput.value);
  });
  toolbarFilterInput.addEventListener('keydown', (e) => { e.stopPropagation(); });

  toolbar.append(backBtn, fwdBtn, histWrap, homeBtn, addressBar.toggleBtn, addressBar.element, toolbarFilterWrap);

  const content = document.createElement('div');
  content.className = 'oi-content';
  main.append(toolbar, content);
  root.append(sidebar.element, main);

  subscribeDocMarkdown((on) => {
    content.querySelectorAll<HTMLButtonElement>('.oi-md-toggle').forEach((btn) => {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    remountDocstrings(content, on);
  });

  let navGen = 0;
  let persistEnabled = true;
  let persistRaf = 0;
  let persistTimer = 0;
  let lastFlushAt = 0;
  let lastFlushed = '';
  let echoScroll = false;
  const PERSIST_INTERVAL_MS = 2000;

  function captureViewState(): ViewState {
    const open: Record<string, boolean> = {};
    const scrolls: Record<string, number> = {};
    content.querySelectorAll<HTMLElement>('[data-view-key]').forEach((el) => {
      const key = el.dataset['viewKey'];
      if (!key) return;
      open[key] = el.dataset['open'] === 'true';
      const scroller = el.querySelector<HTMLElement>('.oi-table-scroll');
      if (scroller) scrolls[key] = scroller.scrollTop;
    });
    return { contentScrollTop: content.scrollTop, open, scrolls };
  }

  function applyViewStateOnce(state: ViewState): void {
    content.querySelectorAll<HTMLElement>('[data-view-key]').forEach((el) => {
      const key = el.dataset['viewKey'];
      if (!key || !(key in state.open)) return;
      const isOpen = state.open[key]!;
      el.dataset['open'] = isOpen ? 'true' : 'false';
      if (el.classList.contains('oi-doc-toggle')) {
        const body = el.nextElementSibling as HTMLElement | null;
        if (body?.classList.contains('oi-namespace-doc')) {
          body.style.display = isOpen ? 'block' : 'none';
        }
        el.textContent = isOpen ? 'Hide docstring' : 'Show full docstring';
      } else {
        const body = el.querySelector<HTMLElement>(':scope > .oi-section-body');
        if (body) body.style.display = isOpen ? 'block' : 'none';
      }
      const scroller = el.querySelector<HTMLElement>('.oi-table-scroll');
      if (scroller && key in state.scrolls) scroller.scrollTop = state.scrolls[key]!;
    });
    content.scrollTop = state.contentScrollTop;
  }

  function applyViewState(state: ViewState, gen: number): void {
    applyViewStateOnce(state);
    requestAnimationFrame(() => {
      if (gen !== navGen) return;
      applyViewStateOnce(state);
    });
  }

  function persistCurrentViewState(force = false): void {
    if (!persistEnabled) return;
    const view = captureViewState();
    const key = JSON.stringify(view);
    if (key === lastFlushed) return;
    const now = Date.now();
    if (!force && now - lastFlushAt < PERSIST_INTERVAL_MS) {
      if (!persistTimer) {
        persistTimer = window.setTimeout(() => {
          persistTimer = 0;
          persistCurrentViewState(true);
        }, PERSIST_INTERVAL_MS - (now - lastFlushAt));
      }
      return;
    }
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
    lastFlushed = key;
    lastFlushAt = now;
    echoScroll = true;
    const top = content.scrollTop;
    const innerTops = new Map<HTMLElement, number>();
    content.querySelectorAll<HTMLElement>('.oi-table-scroll').forEach((el) => {
      innerTops.set(el, el.scrollTop);
    });
    persistViewState(view);
    if (content.scrollTop !== top) content.scrollTop = top;
    for (const [el, y] of innerTops) {
      if (el.scrollTop !== y) el.scrollTop = y;
    }
    requestAnimationFrame(() => { echoScroll = false; });
  }

  function schedulePersist(): void {
    if (echoScroll || !persistEnabled || persistRaf) return;
    persistRaf = requestAnimationFrame(() => {
      persistRaf = 0;
      persistCurrentViewState();
    });
  }

  function freezeViewPersist(): void {
    persistEnabled = false;
    if (persistRaf) {
      cancelAnimationFrame(persistRaf);
      persistRaf = 0;
    }
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
  }

  function thawViewPersist(): void {
    persistEnabled = true;
  }

  function leaveCurrentView(): void {
    persistCurrentViewState(true);
    freezeViewPersist();
  }

  content.addEventListener('scroll', schedulePersist, { passive: true });
  content.addEventListener('scroll', (e) => {
    if ((e.target as HTMLElement).classList?.contains('oi-table-scroll')) schedulePersist();
  }, { passive: true, capture: true });
  content.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('.oi-section-summary, .oi-doc-toggle')) persistCurrentViewState(true);
  });
  window.addEventListener('pagehide', () => persistCurrentViewState(true));

  function pushHistory(obj: ObjectDescription, accessPath: string): void {
    const last = historyEntries[historyEntries.length - 1];
    if (last && last.path === accessPath && last.pkg === obj.package) return;
    historyEntries.push({ pkg: obj.package, path: accessPath, name: obj.name, kind: obj.kind });
    if (historyEntries.length > 50) historyEntries.shift();
    try { localStorage.setItem('db_history', JSON.stringify(historyEntries)); } catch {}
  }

  function unbindToolbarFilter(): void {
    activeMemberTable = null;
  }

  function bindToolbarFilter(handle: MemberTableHandle): void {
    activeMemberTable = handle;
    handle.setFilter(toolbarFilterInput.value);
  }

  function animatedNotice(inner: HTMLElement): HTMLElement {
    const box = document.createElement('div');
    box.className = 'oi-nav-notice';
    const clip = document.createElement('div');
    clip.className = 'oi-nav-notice-clip';
    clip.appendChild(inner);
    box.appendChild(clip);
    return box;
  }

  function missingDataNotice(path: string, pkgName: string, onIngest: () => void): HTMLElement {
    const inner = document.createElement('div');
    inner.className = 'oi-nav-notice-inner';
    const text = document.createElement('p');
    const code = document.createElement('code');
    code.textContent = path;
    text.append(
      code,
      document.createTextNode(` is not loaded. Export ${pkgName} with walk_package.py, then upload the JSON from Ingest package.`),
    );
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oi-nav-notice-btn';
    btn.textContent = 'Manually ingest package';
    attachTooltip(
      btn,
      () => 'Packages you manually add will persist after this window is closed and until you use "Clear uploaded packages" at the bottom left.',
      'bottom-start',
      ['bottom', 'bottom-end'],
    );
    btn.addEventListener('click', onIngest);
    inner.append(text, btn);
    return animatedNotice(inner);
  }

  function renderLoading(): void {
    unbindToolbarFilter();
    content.innerHTML = '<div class="oi-loading">Loading\u2026</div>';
  }

  function renderError(message: string): void {
    unbindToolbarFilter();
    content.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'oi-error';
    box.textContent = message;
    content.appendChild(box);
  }

  function showPypiCard(info: PypiInfo, extras: { emptyInventory?: boolean; error?: string | null } = {}): void {
    leaveCurrentView();
    activePkg = undefined;
    activePypi = info;
    setTitle(info.name);
    addressBar.setValue(info.name);
    unbindToolbarFilter();
    paintPypiCard(info, extras);
    content.scrollTop = 0;
    thawViewPersist();
    updateNavButtons();
  }

  function paintPypiCard(
    info: PypiInfo,
    extras: { emptyInventory?: boolean; error?: string | null; busy?: boolean } = {},
  ): void {
    content.innerHTML = '';
    content.appendChild(renderPypiCard(info, {
      emptyInventory: extras.emptyInventory,
      busy: extras.busy,
      error: extras.error,
      onTryInventory: info.inventoryUrl
        ? () => { void tryInventory(info); }
        : undefined,
      onIngestPackage: () => sidebar.openIngest(),
    }));
  }

  async function tryInventory(info: PypiInfo): Promise<void> {
    const url = info.inventoryUrl;
    if (!url) {
      sidebar.openIngest();
      return;
    }
    paintPypiCard(info, { busy: true });
    try {
      await store.add(info.name, url);
      if (store.isEmptyApi(info.name)) {
        showPypiCard(info, { emptyInventory: true });
        return;
      }
      await navigatePathAndRender(store.rootPath(info.name), info.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      paintPypiCard(info, { error: message });
    }
  }

  function preferredHome(): { pkg: string; path: string } | undefined {
    const pkg = store.has('syntax')
      ? 'syntax'
      : store.has('builtins')
        ? 'builtins'
        : store.loadedNames()[0];
    if (!pkg) return undefined;
    return { pkg, path: store.rootPath(pkg) };
  }

  function renderEmptyHome(): void {
    activePkg = undefined;
    activePypi = undefined;
    setTitle('');
    unbindToolbarFilter();
    addressBar.setValue('');
    content.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'oi-empty-state';
    empty.textContent = 'No packages loaded.';
    content.appendChild(empty);
  }

  async function openHome(opts: {
    replace: boolean;
    restore?: ViewState;
    gen?: number;
  }): Promise<void> {
    const gen = opts.gen ?? ++navGen;
    const home = preferredHome();
    if (!home) {
      if (opts.replace) navigateHome({ replace: true });
      else navigateHome({ replace: false });
      renderEmptyHome();
      thawViewPersist();
      updateNavButtons();
      return;
    }
    if (opts.replace) navigateToPath(home.path, home.pkg, { replace: true });
    await navigatePathAndRender(home.path, home.pkg, !opts.replace, opts.restore, gen);
  }

  async function resetToDefaults(): Promise<void> {
    hideTooltip();
    closeHistoryDropdown();
    setShowUnloaded(false);
    leaveCurrentView();
    await store.resetToDefaults();
    await openHome({ replace: true });
  }

  function renderObject(obj: ObjectDescription, accessPath?: string): void {
    const displayPath = accessPath ?? obj.path;
    const previousPypi = activePypi;
    activePypi = undefined;
    if (store.isEmptyApi(obj.package) && (displayPath === obj.package || !obj.members.length)) {
      void (async () => {
        const info = (previousPypi && previousPypi.name === obj.package)
          ? previousPypi
          : await lookupPypi(obj.package);
        if (info) {
          showPypiCard(info, { emptyInventory: true });
          return;
        }
        leaveCurrentView();
        activePkg = obj.package;
        setTitle(obj.package);
        addressBar.setValue(obj.package);
        unbindToolbarFilter();
        content.innerHTML = '';
        const notice = document.createElement('div');
        notice.className = 'oi-pypi-notice';
        notice.textContent =
          'This Sphinx inventory has no Python API objects (guide pages only).';
        content.appendChild(notice);
        thawViewPersist();
      })();
      return;
    }
    const displayName = obj.dispname || (obj.name.includes('.') ? obj.name.split('.').at(-1)! : obj.name);
    activePkg = obj.package;
    setTitle(displayPath, obj.dispname);
    addressBar.setValue(displayPath);
    content.innerHTML = '';

    const onNavigatePath = (path: string): void => {
      hideTooltip();
      closeHistoryDropdown();
      void navigatePathAndRender(path, obj.package);
    };

    const isNamespace = NAMESPACE_KINDS.has(obj.kind);
    const canonical = obj.aliases[0];
    const truePath = (canonical && canonical !== displayPath)
      ? canonical
      : (obj.path && obj.path !== displayPath ? obj.path : undefined);
    const showPath = !isNamespace || displayPath.includes('.');
    const mdToggle = (!isNamespace || Boolean(obj.doc?.trim())) ? makeMarkdownToggle() : null;
    const pathBar = showPath
      ? renderPathBar(
        displayPath,
        obj.kind,
        obj.package,
        onNavigatePath,
        truePath,
        obj.dispname,
        mdToggle ?? undefined,
      )
      : null;

    if (isNamespace) {
      if (pathBar) content.appendChild(pathBar);
      const header = document.createElement('div');
      header.className = 'oi-header';

      const title = document.createElement('div');
      title.className = 'oi-header-title';
      title.appendChild(iconEl(obj.kind, obj.package));
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName;
      title.appendChild(nameSpan);
      if (!pathBar && mdToggle) {
        const titleRow = document.createElement('div');
        titleRow.className = 'oi-header-title-row';
        titleRow.append(title, mdToggle);
        header.appendChild(titleRow);
      } else {
        header.appendChild(title);
      }

      if (obj.doc_summary) {
        const summaryEl = document.createElement('div');
        summaryEl.className = 'oi-header-summary';
        summaryEl.textContent = obj.doc_summary;
        header.appendChild(summaryEl);
      }
      if (obj.doc && obj.doc.trim().includes('\n')) {
        const docToggle = document.createElement('button');
        docToggle.type = 'button';
        docToggle.className = 'oi-doc-toggle';
        docToggle.dataset.viewKey = 'namespace-doc';
        docToggle.dataset.open = 'false';
        docToggle.textContent = 'Show full docstring';
        const docBody = document.createElement('div');
        docBody.className = 'oi-function-doc oi-namespace-doc';
        docBody.style.display = 'none';
        mountDocstring(docBody, obj.doc, getDocMarkdown());
        docToggle.addEventListener('click', () => {
          const expanded = docToggle.dataset['open'] !== 'true';
          docToggle.dataset['open'] = expanded ? 'true' : 'false';
          docBody.style.display = expanded ? 'block' : 'none';
          docToggle.textContent = expanded ? 'Hide docstring' : 'Show full docstring';
        });
        header.append(docToggle, docBody);
      }

      const stats = document.createElement('div');
      stats.className = 'oi-stats';
      stats.textContent = `${obj.member_count} member${obj.member_count === 1 ? '' : 's'}`;
      header.appendChild(stats);

      if (obj.docUri) {
        const docsLink = document.createElement('a');
        docsLink.className = 'oi-docs-link';
        docsLink.href = obj.docUri;
        docsLink.target = '_blank';
        docsLink.rel = 'noopener noreferrer';
        docsLink.textContent = 'Open official docs';
        header.appendChild(docsLink);
      }

      content.appendChild(header);
      const tableHandle = renderMemberTable(obj.members, {
        onNavigatePath,
        autoExpand: obj.package === 'syntax' && obj.path !== 'syntax',
        parentAccessPath: displayPath,
        pkg: obj.package,
      });
      content.appendChild(tableHandle.element);
      bindToolbarFilter(tableHandle);
    } else {
      unbindToolbarFilter();
      const view = renderFunctionView(obj, {
        onNavigatePath,
        currentPath: displayPath,
        pkg: obj.package,
      });
      const sticky = document.createElement('div');
      sticky.className = 'oi-sticky-head';
      if (pathBar) sticky.appendChild(pathBar);
      sticky.appendChild(view.sigRow);
      content.append(sticky, view.body);
      if (obj.kind === 'class' && obj.members.length > 0) {
        const classTableHandle = renderMemberTable(obj.members, {
          onNavigatePath,
          autoExpand: true,
          parentAccessPath: displayPath,
          pkg: obj.package,
        });
        content.appendChild(classTableHandle.element);
        bindToolbarFilter(classTableHandle);
      }
    }
  }

  async function navigatePathAndRender(
    path: string,
    pkg?: string,
    updateUrl = true,
    restore?: ViewState,
    gen = ++navGen,
  ): Promise<void> {
    if (updateUrl) persistCurrentViewState(true);
    freezeViewPersist();
    try {
      if (pkg && !store.has(pkg)) {
        await store.add(pkg);
      }
      if (gen !== navGen) return;
      const obj = await fetchObjectByPath(path);
      if (gen !== navGen) return;
      renderLoading();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      if (gen !== navGen) return;
      pushHistory(obj, path);
      if (updateUrl) navigateToPath(obj.package, path);
      renderObject(obj, path);
      if (restore) applyViewState(restore, gen);
      else content.scrollTop = 0;
    } catch (err) {
      if (gen !== navGen) return;
      const raw = err instanceof Error ? err.message : String(err);
      const missing = raw.startsWith('Missing bundled data:');
      const pkgName = path.split('.')[0] || path;
      const route = parseCurrentRoute();
      const stayed = route.kind === 'object' && route.path !== path;
      if (stayed && missing) {
        content.querySelector('.oi-nav-notice')?.remove();
        content.prepend(missingDataNotice(path, pkgName, () => sidebar.openIngest()));
      } else if (stayed) {
        content.querySelector('.oi-nav-notice')?.remove();
        const inner = document.createElement('div');
        inner.className = 'oi-nav-notice-inner';
        inner.textContent = raw;
        content.prepend(animatedNotice(inner));
      } else {
        renderError(missing
          ? `${path} is not loaded. Export ${pkgName} with walk_package.py and upload the JSON from Ingest package.`
          : raw);
      }
    }
    if (gen !== navGen) return;
    thawViewPersist();
    updateNavButtons();
  }

  async function loadRoute(): Promise<void> {
    const gen = ++navGen;
    freezeViewPersist();
    updateNavButtons();
    const view = readViewState();
    const route = parseCurrentRoute();
    if (route.kind === 'home') {
      const home = preferredHome();
      if (!home) {
        renderEmptyHome();
        thawViewPersist();
        return;
      }
      navigateToPath(home.path, home.pkg, { replace: true });
      await navigatePathAndRender(home.path, home.pkg, false, view, gen);
      return;
    }
    await navigatePathAndRender(route.path, route.pkg, false, view, gen);
  }

  store.subscribe(() => {
    if (activePkg && !store.has(activePkg) && !store.isPending(activePkg)) {
      leaveCurrentView();
      void openHome({ replace: true });
    }
  });

  onRouteChange(() => { void loadRoute(); });

  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'oi-drop-overlay';
  dropOverlay.hidden = true;
  dropOverlay.setAttribute('aria-hidden', 'true');
  const dropInner = document.createElement('div');
  dropInner.className = 'oi-drop-overlay-inner';
  const dropIcon = document.createElement('span');
  dropIcon.className = 'codicon codicon-cloud-upload';
  dropIcon.setAttribute('aria-hidden', 'true');
  const dropTitle = document.createElement('div');
  dropTitle.className = 'oi-drop-title';
  dropTitle.textContent = 'Drop to ingest JSON';
  const dropSub = document.createElement('div');
  dropSub.className = 'oi-drop-sub';
  dropSub.textContent = 'See INGEST PACKAGE for more information.';
  dropInner.append(dropIcon, dropTitle, dropSub);
  dropOverlay.appendChild(dropInner);
  document.querySelectorAll('.oi-drop-overlay').forEach((el) => el.remove());
  document.body.appendChild(dropOverlay);

  let dragEnterCount = 0;

  function dragHasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  function showDropOverlay(): void {
    dropOverlay.hidden = false;
    dropOverlay.setAttribute('aria-hidden', 'false');
  }

  function hideDropOverlay(): void {
    dragEnterCount = 0;
    dropOverlay.hidden = true;
    dropOverlay.setAttribute('aria-hidden', 'true');
  }

  window.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragEnterCount += 1;
    showDropOverlay();
  });
  window.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragEnterCount = Math.max(0, dragEnterCount - 1);
    if (dragEnterCount === 0) hideDropOverlay();
  });
  window.addEventListener('dragend', () => hideDropOverlay());
  window.addEventListener('drop', (e) => {
    const files = dragHasFiles(e);
    hideDropOverlay();
    if (!files) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    void sidebar.ingestFile(file);
  });

  await loadRoute();
}
