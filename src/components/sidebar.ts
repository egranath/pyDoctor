import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import walkPackageUrl from '../../scripts/walk_package.py?url';
import { searchPypiMeta } from '../api';
import { INGEST_MEMORY_MAX_BYTES, packageCacheFromFile } from '../cache/ingestFile';
import { store } from '../cache/store';
import { highlightPython } from '../highlight';
import { iconEl } from '../icons';
import { TOOLTIP_DELAY_MS } from './tooltip';
import type { CacheIndexEntry, PypiInfo } from '../types';

const WALK_SNIPPET = [
  'import os, sys',
  "sys.path.append('path_to_script')",
  'from walk_package import walk_package',
  'walk_package(PACKAGE)',
].join('\n');
const HELP_HIDE_GRACE_MS = 150;
const RESET_ICON_SVG = `<svg class="oi-reset-icon" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="currentColor" d="M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6c0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8m0 14a6 6 0 0 1-6-6c0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4z"/>
</svg>`;

export interface SidebarHandle {
  element: HTMLElement;
  openIngest: (error?: string) => void;
  ingestFile: (file: File) => Promise<void>;
}

interface SidebarOptions {
  onOpenPackage: (name: string) => void;
  onPypi: (info: PypiInfo) => void;
  onError: (message: string) => void;
  onReset: () => void;
  getActivePackage: () => string | undefined;
}

type ComboRow =
  | { kind: 'catalog'; name: string }
  | { kind: 'pypi'; info: PypiInfo };

type SidebarGroupId = 'core' | 'stdlib' | 'thirdParty' | 'manual';

const SIDEBAR_GROUPS: { id: SidebarGroupId; label: string }[] = [
  { id: 'core', label: 'Core' },
  { id: 'stdlib', label: 'Standard library' },
  { id: 'thirdParty', label: 'Third party' },
  { id: 'manual', label: 'Manually added' },
];
const GROUPS_KEY = 'db_sidebar_groups';

function readGroupOpen(): Record<SidebarGroupId, boolean> {
  const defaults: Record<SidebarGroupId, boolean> = {
    core: true,
    stdlib: true,
    thirdParty: true,
    manual: true,
  };
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<SidebarGroupId, boolean>>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function writeGroupOpen(open: Record<SidebarGroupId, boolean>): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(open));
  } catch {
    // ignore quota / private mode
  }
}

export function createSidebar(options: SidebarOptions): SidebarHandle {
  const root = document.createElement('aside');
  root.className = 'oi-sidebar';

  const add = document.createElement('div');
  add.className = 'oi-sidebar-add';

  const comboWrap = document.createElement('div');
  comboWrap.className = 'oi-sidebar-combo';
  const comboInput = document.createElement('input');
  comboInput.type = 'text';
  comboInput.className = 'oi-sidebar-combo-input';
  comboInput.placeholder = 'Add package';
  comboInput.autocomplete = 'off';
  comboInput.spellcheck = false;
  const comboList = document.createElement('div');
  comboList.className = 'oi-sidebar-combo-list';
  comboList.style.display = 'none';
  comboWrap.append(comboInput, comboList);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'oi-nav-btn oi-sidebar-reset';
  resetBtn.title = 'Reset to default';
  resetBtn.setAttribute('aria-label', 'Reset to default');
  resetBtn.innerHTML = RESET_ICON_SVG;
  resetBtn.addEventListener('click', () => {
    if (store.isDefaultSidebar()) return;
    if (!confirm('Reset packages to defaults? Extra listings will be removed.\nThis will not remove any manually uploaded packages.')) return;
    options.onReset();
  });

  const addRow = document.createElement('div');
  addRow.className = 'oi-sidebar-add-row';
  addRow.append(comboWrap, resetBtn);

  const ingestForm = document.createElement('div');
  ingestForm.className = 'oi-sidebar-ingest';
  const ingestInner = document.createElement('div');
  ingestInner.className = 'oi-sidebar-ingest-inner';

  const ingestToggle = document.createElement('button');
  ingestToggle.type = 'button';
  ingestToggle.className = 'oi-sidebar-url-toggle oi-sidebar-group-summary';
  ingestToggle.setAttribute('aria-expanded', 'false');
  const ingestChevron = document.createElement('span');
  ingestChevron.className = 'codicon codicon-chevron-down oi-chevron';
  ingestChevron.setAttribute('aria-hidden', 'true');
  const ingestLabel = document.createElement('span');
  ingestLabel.className = 'oi-sidebar-group-label';
  ingestLabel.textContent = 'Ingest package';
  ingestToggle.append(ingestChevron, ingestLabel);

  const hint = document.createElement('div');
  hint.className = 'oi-sidebar-hint';
  const hintTitle = document.createElement('div');
  hintTitle.className = 'oi-ingest-hint-title';
  hintTitle.textContent = 'In your own Python environment:';
  const steps = document.createElement('ul');
  steps.className = 'oi-ingest-steps';
  const stepImport = document.createElement('li');
  stepImport.textContent = 'Import a package';
  const stepExport = document.createElement('li');
  const exportLine = document.createElement('span');
  exportLine.className = 'oi-ingest-step-inline';
  exportLine.append('Export using ');
  const scriptLink = document.createElement('a');
  scriptLink.className = 'oi-ingest-download';
  scriptLink.href = walkPackageUrl;
  scriptLink.download = 'walk_package.py';
  scriptLink.textContent = 'walk_package.py';
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'oi-ingest-help';
  helpBtn.setAttribute('aria-label', 'How to run walk_package.py');
  helpBtn.setAttribute('aria-expanded', 'false');
  const helpIco = document.createElement('span');
  helpIco.className = 'codicon codicon-question';
  helpIco.setAttribute('aria-hidden', 'true');
  helpBtn.appendChild(helpIco);
  exportLine.append(scriptLink, helpBtn);
  stepExport.appendChild(exportLine);
  const stepUpload = document.createElement('li');
  stepUpload.textContent = 'Upload the JSON file here';
  steps.append(stepImport, stepExport, stepUpload);
  hint.append(hintTitle, steps);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.className = 'oi-ingest-file';
  const chooseBtn = document.createElement('button');
  chooseBtn.type = 'button';
  chooseBtn.className = 'oi-sidebar-add-btn';
  chooseBtn.textContent = 'Choose JSON file';

  const errEl = document.createElement('div');
  errEl.className = 'oi-sidebar-add-error';
  errEl.style.display = 'none';

  const ingestFooter = document.createElement('div');
  ingestFooter.className = 'oi-ingest-footer';
  const sizeEl = document.createElement('div');
  sizeEl.className = 'oi-ingest-size';
  sizeEl.textContent = 'Uploaded packages: 0 B';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'oi-sidebar-add-btn';
  clearBtn.textContent = 'Clear uploaded packages';
  ingestFooter.append(sizeEl, clearBtn);

  ingestInner.append(hint, fileInput, chooseBtn, errEl, ingestFooter);
  ingestForm.appendChild(ingestInner);
  add.append(addRow);

  const list = document.createElement('div');
  list.className = 'oi-sidebar-list';

  const bottom = document.createElement('div');
  bottom.className = 'oi-sidebar-bottom';
  const bottomRule = document.createElement('div');
  bottomRule.className = 'oi-sidebar-bottom-rule';
  bottomRule.setAttribute('aria-hidden', 'true');
  bottom.append(bottomRule, ingestForm, ingestToggle);

  root.append(add, list, bottom);

  let comboRows: ComboRow[] = [];
  let comboIndex = -1;
  let comboOpen = false;
  let comboSeq = 0;
  let comboTimer: number | undefined;
  let comboAbort: AbortController | undefined;

  function setError(message: string | null): void {
    errEl.classList.remove('is-progress');
    if (!message) {
      errEl.style.display = 'none';
      errEl.textContent = '';
      return;
    }
    errEl.style.display = 'block';
    errEl.textContent = message;
  }

  function setProgress(message: string | null): void {
    if (!message) {
      if (errEl.classList.contains('is-progress')) setError(null);
      return;
    }
    errEl.classList.add('is-progress');
    errEl.style.display = 'block';
    errEl.textContent = message;
  }

  function catalogEntryMatches(entry: CacheIndexEntry, q: string): boolean {
    if (!q) return true;
    if (entry.name.toLowerCase().includes(q)) return true;
    return (entry.aliases ?? []).some((alias) => alias.toLowerCase().includes(q));
  }

  function catalogChoices(): string[] {
    const listed = new Set(store.listedNames());
    const q = comboInput.value.trim().toLowerCase();
    return store.catalog()
      .filter((entry) => !listed.has(entry.name))
      .filter((entry) => catalogEntryMatches(entry, q))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  function hideCombo(): void {
    comboList.style.display = 'none';
    comboIndex = -1;
    comboOpen = false;
  }

  function renderComboRows(rows: ComboRow[]): void {
    if (!comboOpen) return;
    comboRows = rows;
    comboList.innerHTML = '';
    if (comboRows.length === 0) {
      comboList.style.display = 'none';
      return;
    }
    comboRows.forEach((row, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'oi-sidebar-combo-item'
        + (row.kind === 'pypi' ? ' oi-sidebar-combo-item-pypi' : '')
        + (i === comboIndex ? ' is-active' : '');
      if (row.kind === 'catalog') {
        el.append(iconEl('package', row.name), document.createTextNode(row.name));
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          void pickPackage(row.name);
        });
      } else {
        const badge = document.createElement('span');
        badge.className = 'oi-pypi-badge';
        badge.textContent = 'PyPI';
        const name = document.createElement('span');
        name.textContent = row.info.name;
        const doc = document.createElement('span');
        doc.className = 'oi-sidebar-combo-doc';
        doc.textContent = row.info.summary || '';
        el.append(badge, name, doc);
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickPypi(row.info);
        });
      }
      comboList.appendChild(el);
    });
    comboList.style.display = 'block';
  }

  function renderCombo(): void {
    if (!comboOpen) return;
    const catalog = catalogChoices();
    if (catalog.length > 0) {
      comboAbort?.abort();
      renderComboRows(catalog.map((name) => ({ kind: 'catalog', name })));
      return;
    }
    const q = comboInput.value.trim();
    if (!q) {
      comboRows = [];
      comboList.style.display = 'none';
      return;
    }
    window.clearTimeout(comboTimer);
    comboTimer = window.setTimeout(() => { void loadComboPypi(q); }, 120);
  }

  async function loadComboPypi(query: string): Promise<void> {
    const seq = ++comboSeq;
    comboAbort?.abort();
    comboAbort = new AbortController();
    const hits = await searchPypiMeta(query, comboAbort.signal);
    if (seq !== comboSeq || !comboOpen) return;
    if (catalogChoices().length > 0) return;
    renderComboRows(hits.map((info) => ({ kind: 'pypi', info })));
  }

  async function pickPackage(name: string): Promise<void> {
    setError(null);
    hideCombo();
    comboInput.value = '';
    comboInput.blur();
    options.onOpenPackage(name);
  }

  function pickPypi(info: PypiInfo): void {
    setError(null);
    hideCombo();
    comboInput.value = '';
    comboInput.blur();
    options.onPypi(info);
  }

  let groupOpen = readGroupOpen();

  function groupFor(name: string): SidebarGroupId {
    if (store.isCore(name)) return 'core';
    if (store.isManuallyAdded(name)) return 'manual';
    if (store.isStdlib(name)) return 'stdlib';
    return 'thirdParty';
  }

  function renderPackageRow(name: string, listedSet: Set<string>): HTMLElement {
    const loaded = store.has(name) || store.isPending(name);
    const pinned = store.isPinned(name);
    const core = store.isCore(name);
    const manual = store.isManuallyAdded(name);
    const row = document.createElement('div');
    row.className = 'oi-sidebar-item'
      + (name === options.getActivePackage() ? ' is-active' : '')
      + (loaded ? '' : ' is-unloaded')
      + (core ? ' is-core' : '')
      + (manual ? ' is-manual' : '');

    const addOrToggle = (): void => {
      if (pinned) return;
      void (async () => {
        try {
          if (!store.has(name)) await store.setLoaded(name, true);
          else await store.setLoaded(name, false);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          options.onError(message);
        }
      })();
    };

    const radioHit = document.createElement('div');
    radioHit.className = 'oi-sidebar-item-hit oi-sidebar-item-hit-radio';

    const radio = document.createElement('button');
    radio.type = 'button';
    radio.className = 'oi-sidebar-radio' + (loaded ? ' is-on' : '');
    radio.setAttribute('role', 'switch');
    radio.setAttribute('aria-checked', loaded ? 'true' : 'false');
    radio.setAttribute('aria-label', loaded ? `Unload ${name}` : `Load ${name}`);
    if (pinned) {
      radio.disabled = true;
      radio.setAttribute('aria-label', `${name} is always loaded`);
    } else {
      const onToggle = (e: Event) => {
        e.stopPropagation();
        addOrToggle();
      };
      radio.addEventListener('click', onToggle);
      radioHit.addEventListener('click', onToggle);
    }
    radioHit.appendChild(radio);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'oi-sidebar-item-name';
    openBtn.textContent = name;
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onOpenPackage(name);
    });

    const trailHit = document.createElement('div');
    trailHit.className = 'oi-sidebar-item-hit oi-sidebar-item-hit-trail';
    if (!pinned) {
      trailHit.addEventListener('click', (e) => {
        e.stopPropagation();
        addOrToggle();
      });
    }

    row.append(radioHit, openBtn, trailHit);
    if (!pinned && !core && listedSet.has(name)) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'oi-sidebar-remove';
      removeBtn.title = `Remove ${name}`;
      const x = document.createElement('span');
      x.className = 'codicon codicon-close';
      removeBtn.appendChild(x);
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.unlist(name);
      });
      row.appendChild(removeBtn);
    }
    return row;
  }

  function renderList(): void {
    const listed = store.listedNames();
    const listedSet = new Set(listed);
    const grouped: Record<SidebarGroupId, string[]> = {
      core: [],
      stdlib: [],
      thirdParty: [],
      manual: [],
    };
    for (const name of listed) grouped[groupFor(name)].push(name);

    list.innerHTML = '';
    const visibleGroups = SIDEBAR_GROUPS.filter((group) => grouped[group.id].length > 0);
    if (visibleGroups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'oi-sidebar-empty';
      empty.textContent = 'No packages listed. Add one from the catalog.';
      list.appendChild(empty);
      return;
    }

    for (const group of visibleGroups) {
      const names = grouped[group.id];
      const section = document.createElement('div');
      section.className = 'oi-sidebar-group';
      const open = groupOpen[group.id];
      section.dataset.open = open ? 'true' : 'false';

      const summary = document.createElement('button');
      summary.type = 'button';
      summary.className = 'oi-sidebar-group-summary';
      summary.setAttribute('aria-expanded', open ? 'true' : 'false');
      const chevron = document.createElement('span');
      chevron.className = 'codicon codicon-chevron-down oi-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'oi-sidebar-group-label';
      label.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'oi-sidebar-group-count';
      count.textContent = `(${names.length})`;
      const title = document.createElement('span');
      title.className = 'oi-sidebar-group-title';
      title.append(label, count);
      summary.append(chevron, title);

      const body = document.createElement('div');
      body.className = 'oi-sidebar-group-body';
      body.hidden = !open;
      for (const name of names) body.appendChild(renderPackageRow(name, listedSet));

      summary.addEventListener('click', () => {
        const next = section.dataset['open'] !== 'true';
        section.dataset['open'] = next ? 'true' : 'false';
        summary.setAttribute('aria-expanded', next ? 'true' : 'false');
        body.hidden = !next;
        groupOpen = { ...groupOpen, [group.id]: next };
        writeGroupOpen(groupOpen);
      });

      section.append(summary, body);
      list.appendChild(section);
    }
  }

  comboInput.addEventListener('input', () => {
    comboIndex = -1;
    comboOpen = true;
    renderCombo();
  });
  comboInput.addEventListener('focus', () => {
    comboOpen = true;
    renderCombo();
  });
  comboInput.addEventListener('blur', () => {
    window.setTimeout(() => hideCombo(), 120);
  });
  comboInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      comboOpen = true;
      if (comboList.style.display === 'none') renderCombo();
      if (!comboRows.length) return;
      comboIndex = (comboIndex + 1) % comboRows.length;
      renderComboRows(comboRows);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!comboRows.length) return;
      comboIndex = (comboIndex - 1 + comboRows.length) % comboRows.length;
      renderComboRows(comboRows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = comboIndex >= 0 ? comboRows[comboIndex] : comboRows[0];
      if (row?.kind === 'catalog') void pickPackage(row.name);
      else if (row?.kind === 'pypi') pickPypi(row.info);
    } else if (e.key === 'Escape') {
      hideCombo();
    }
  });

  let helpTip: HTMLDivElement | null = null;
  let helpPinned = false;
  let helpSeq = 0;
  let helpShowTimer: number | undefined;
  let helpHideTimer: number | undefined;

  function cancelHelpTimers(): void {
    if (helpShowTimer) window.clearTimeout(helpShowTimer);
    if (helpHideTimer) window.clearTimeout(helpHideTimer);
    helpShowTimer = undefined;
    helpHideTimer = undefined;
  }

  function hideHelpTip(): void {
    helpSeq += 1;
    cancelHelpTimers();
    helpPinned = false;
    helpTip?.remove();
    helpTip = null;
    helpBtn.setAttribute('aria-expanded', 'false');
  }

  function scheduleHideHelpTip(): void {
    if (helpHideTimer) window.clearTimeout(helpHideTimer);
    helpHideTimer = window.setTimeout(hideHelpTip, HELP_HIDE_GRACE_MS);
  }

  async function showHelpTip(): Promise<void> {
    if (helpTip) return;
    const seq = ++helpSeq;
    const tip = document.createElement('div');
    tip.className = 'oi-tooltip oi-ingest-help-tip';
    tip.setAttribute('role', 'tooltip');
    const snippet = document.createElement('div');
    snippet.className = 'oi-doc-code oi-ingest-help-snippet';
    const highlighted = await highlightPython(WALK_SNIPPET);
    if (seq !== helpSeq) return;
    snippet.innerHTML = highlighted;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'oi-ingest-help-copy';
    copyBtn.title = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy snippet');
    const copyIco = document.createElement('span');
    copyIco.className = 'codicon codicon-copy';
    copyIco.setAttribute('aria-hidden', 'true');
    copyBtn.appendChild(copyIco);
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(WALK_SNIPPET).then(() => {
        copyIco.className = 'codicon codicon-check';
        copyBtn.title = 'Copied';
        window.setTimeout(() => {
          copyIco.className = 'codicon codicon-copy';
          copyBtn.title = 'Copy';
        }, 1200);
      }).catch(() => {
        /* clipboard may be blocked */
      });
    });
    snippet.appendChild(copyBtn);
    tip.appendChild(snippet);
    tip.addEventListener('mouseenter', cancelHelpTimers);
    tip.addEventListener('mouseleave', () => {
      if (!helpPinned) scheduleHideHelpTip();
    });
    document.body.appendChild(tip);
    helpTip = tip;
    helpBtn.setAttribute('aria-expanded', 'true');
    const { x, y } = await computePosition(helpBtn, tip, {
      placement: 'top-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    });
    if (helpTip !== tip) {
      tip.remove();
      return;
    }
    Object.assign(tip.style, { left: `${x}px`, top: `${y}px` });
  }

  helpBtn.addEventListener('mouseenter', () => {
    cancelHelpTimers();
    if (helpTip) return;
    helpShowTimer = window.setTimeout(() => { void showHelpTip(); }, TOOLTIP_DELAY_MS);
  });
  helpBtn.addEventListener('mouseleave', () => {
    cancelHelpTimers();
    if (helpTip && !helpPinned) scheduleHideHelpTip();
  });
  helpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelHelpTimers();
    if (helpTip && helpPinned) {
      hideHelpTip();
      return;
    }
    helpPinned = true;
    void showHelpTip();
  });
  document.addEventListener('mousedown', (e) => {
    if (!helpTip) return;
    const t = e.target as Node | null;
    if (t && (helpTip.contains(t) || helpBtn.contains(t))) return;
    hideHelpTip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideHelpTip();
  });

  function setIngestOpen(open: boolean): void {
    ingestForm.classList.toggle('is-open', open);
    ingestToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    ingestToggle.classList.toggle('is-open', open);
    if (!open) hideHelpTip();
  }

  ingestToggle.addEventListener('click', () => {
    const open = !ingestForm.classList.contains('is-open');
    setIngestOpen(open);
    if (!open) setError(null);
  });

  async function ingestFile(file: File): Promise<void> {
    setError(null);
    if (file.size > INGEST_MEMORY_MAX_BYTES) setIngestOpen(true);
    fileInput.disabled = true;
    chooseBtn.disabled = true;
    chooseBtn.setAttribute('aria-busy', 'true');
    try {
      const cache = await packageCacheFromFile(file, setProgress);
      await store.addCache(cache, setProgress);
      fileInput.value = '';
      setProgress(null);
      setIngestOpen(false);
      options.onOpenPackage(cache.package);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setProgress(null);
      setIngestOpen(true);
      setError(message);
    } finally {
      fileInput.disabled = false;
      chooseBtn.disabled = false;
      chooseBtn.removeAttribute('aria-busy');
    }
  }

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void ingestFile(file);
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear uploaded packages?')) return;
    void (async () => {
      setError(null);
      clearBtn.disabled = true;
      try {
        await store.clearUploadedPackages();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        clearBtn.disabled = false;
      }
    })();
  });

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  async function refreshUploadStats(): Promise<void> {
    const stats = await store.uploadedCacheStats();
    sizeEl.textContent = `Uploaded packages: ${formatBytes(stats.bytes)}`;
    clearBtn.disabled = stats.names.length === 0;
  }

  function openIngest(error?: string): void {
    setIngestOpen(true);
    setError(error ?? null);
    chooseBtn.focus();
  }

  store.subscribe(() => {
    renderList();
    void refreshUploadStats();
    if (comboOpen && document.activeElement === comboInput) renderCombo();
  });
  renderList();
  void refreshUploadStats();

  return { element: root, openIngest, ingestFile };
}
