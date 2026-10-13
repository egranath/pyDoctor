import type { Member, Kind } from '../types';
import { iconEl, colorFor } from '../icons';
import { attachTooltip } from './tooltip';
import { displaySignature, escapeHtml, isSingleCharLabel } from '../utils';
import { hrefFor } from '../router';
import { lastSegment, parentPath } from '../cache/paths';

type BucketKey =
  | 'functions'
  | 'classes'
  | 'modules'
  | 'calls'
  | 'formatting'
  | 'keywords'
  | 'operators'
  | 'syntax'
  | 'properties'
  | 'data'
  | 'other'
  | 'private';

const BUCKET_META: Record<BucketKey, { label: string; icon: Kind }> = {
  functions: { label: 'Functions & Methods', icon: 'function' },
  classes: { label: 'Classes', icon: 'class' },
  modules: { label: 'Modules & Packages', icon: 'module' },
  calls: { label: 'Functions & arguments', icon: 'call' },
  formatting: { label: 'Strings & formatting', icon: 'formatting' },
  keywords: { label: 'Keywords', icon: 'keyword' },
  operators: { label: 'Special syntax', icon: 'operator' },
  syntax: { label: 'Syntax', icon: 'syntax' },
  properties: { label: 'Properties', icon: 'property' },
  data: { label: 'Constants & Data', icon: 'constant' },
  other: { label: 'Other', icon: 'instance' },
  private: { label: 'Private & Dunder Objects', icon: 'unknown' },
};

const BUCKET_ORDER: BucketKey[] = [
  'functions',
  'classes',
  'modules',
  'calls',
  'formatting',
  'keywords',
  'operators',
  'syntax',
  'properties',
  'data',
  'other',
  'private',
];

function bucketOf(member: Member): BucketKey {
  if (member.is_private) return 'private';
  switch (member.kind) {
    case 'function':
    case 'method':
      return 'functions';
    case 'class':
      return 'classes';
    case 'module':
    case 'package':
      return 'modules';
    case 'keyword':
      return 'keywords';
    case 'operator':
    case 'punctuation':
      return 'operators';
    case 'call':
      return 'calls';
    case 'formatting':
      return 'formatting';
    case 'syntax':
      return 'syntax';
    case 'property':
      return 'properties';
    case 'constant':
    case 'variable':
      return 'data';
    default:
      return 'other';
  }
}

interface MemberTableOptions {
  onNavigatePath: (path: string) => void;
  autoExpand?: boolean;
  parentAccessPath?: string;
  pkg: string;
}

const ROW_SCROLL_THRESHOLD = 25;
const ROW_HEIGHT_ESTIMATE = 24;

export interface MemberTableHandle {
  element: HTMLElement;
  setFilter: (q: string) => void;
}

function withoutKeywordDuplicates(members: Member[]): Member[] {
  const keywordDocs = new Map<string, Set<string>>();
  for (const member of members) {
    if (member.kind !== 'keyword') continue;
    const uris = keywordDocs.get(member.name) ?? new Set();
    uris.add(member.docUri ?? '');
    keywordDocs.set(member.name, uris);
  }
  return members.filter((member) => {
    if (member.kind !== 'operator' && member.kind !== 'punctuation') return true;
    const uris = keywordDocs.get(member.name);
    if (!uris) return true;
    return !uris.has(member.docUri ?? '');
  });
}

export function renderMemberTable(members: Member[], options: MemberTableOptions): MemberTableHandle {
  const root = document.createElement('div');
  root.className = 'oi-member-table-root';
  members = withoutKeywordDuplicates(members);

  if (members.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'oi-empty-state';
    empty.textContent = 'No members found.';
    root.appendChild(empty);
    return { element: root, setFilter: () => {} };
  }

  const groups = new Map<BucketKey, Member[]>();
  for (const m of members) {
    const key = bucketOf(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  const sections: HTMLElement[] = [];
  for (const key of BUCKET_ORDER) {
    const items = groups.get(key);
    if (items && items.length) {
      const section = renderSection(key, items, options, options.autoExpand && key !== 'private');
      sections.push(section);
      root.appendChild(section);
    }
  }

  function normFilter(s: string): string {
    return s.replace(/_/g, '').replace(/\s/g, '').toLowerCase();
  }

  function applyFilter(rawQuery: string): void {
    const q = normFilter(rawQuery.trim());
    let anyVisible = false;
    for (const section of sections) {
      const rows = section.querySelectorAll<HTMLElement>('tr.oi-table-row');
      let sectionHit = false;
      rows.forEach((row) => {
        const hay = normFilter(row.dataset['search'] ?? '');
        const show = !q || hay.includes(q);
        row.style.display = show ? '' : 'none';
        if (show) sectionHit = true;
      });
      section.style.display = (q && !sectionHit) ? 'none' : '';
      if (q && sectionHit) section.dataset['open'] = 'true';
      const body = section.querySelector<HTMLElement>('.oi-section-body');
      if (body && q && sectionHit) body.style.display = 'block';
      anyVisible = anyVisible || sectionHit || !q;
    }
    let noResults = root.querySelector<HTMLElement>('.oi-filter-empty');
    if (!anyVisible && q) {
      if (!noResults) {
        noResults = document.createElement('div');
        noResults.className = 'oi-filter-empty oi-empty-state';
        noResults.textContent = 'No members match your filter.';
        root.appendChild(noResults);
      }
    } else if (noResults) {
      noResults.remove();
    }
  }

  return { element: root, setFilter: applyFilter };
}

function computeColumnWidths(items: Member[]): [number, number, number] {
  const hasSig = items.some((m) => m.signature || m.value_preview);
  const maxNameLen = Math.max(...items.map((m) => m.name.length), 4);
  const nameWidth = Math.min(24, Math.max(12, maxNameLen * 0.9));
  if (!hasSig) {
    return [nameWidth, 0, 100 - nameWidth];
  }
  const maxSigLen = Math.max(...items.map((m) => (m.signature || m.value_preview || '').length), 4);
  const sigWidth = Math.min(36, Math.max(14, maxSigLen * 0.7));
  const docWidth = Math.max(28, 100 - nameWidth - sigWidth);
  return [nameWidth, sigWidth, docWidth];
}

function renderSection(key: BucketKey, items: Member[], options: MemberTableOptions, startOpen = false): HTMLElement {
  const meta = BUCKET_META[key];
  const [w0, w1, w2] = computeColumnWidths(items);
  const sigHidden = w1 === 0;

  const section = document.createElement('div');
  section.className = 'oi-section';
  section.dataset.viewKey = key;
  section.dataset.open = startOpen ? 'true' : 'false';

  const summary = document.createElement('div');
  summary.className = 'oi-section-summary';
  const chevron = document.createElement('span');
  chevron.className = 'codicon codicon-chevron-down oi-chevron';
  const ico = iconEl(meta.icon);
  if (key === 'private') {
    ico.classList.add('oi-icon-muted');
    ico.style.color = 'var(--oi-muted)';
  }
  const label = document.createElement('span');
  label.textContent = meta.label;
  const count = document.createElement('span');
  count.className = 'oi-section-count';
  count.textContent = ` (${items.length})`;
  summary.append(chevron, ico, label, count);

  const body = document.createElement('div');
  body.className = 'oi-section-body';
  body.style.display = startOpen ? 'block' : 'none';

  summary.addEventListener('click', () => {
    const isOpen = section.dataset['open'] === 'true';
    section.dataset['open'] = isOpen ? 'false' : 'true';
    body.style.display = isOpen ? 'none' : 'block';
  });

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'oi-table-scroll oi-col-scope' + (sigHidden ? ' oi-no-sig-scope' : '');
  scrollWrap.style.maxHeight = items.length > ROW_SCROLL_THRESHOLD ? `${ROW_SCROLL_THRESHOLD * ROW_HEIGHT_ESTIMATE}px` : 'none';
  scrollWrap.style.setProperty('--oi-col0', `${w0}%`);
  if (!sigHidden) scrollWrap.style.setProperty('--oi-col1', `${w1}%`);
  scrollWrap.style.setProperty('--oi-col2', `${w2}%`);

  const table = document.createElement('table');
  table.className = 'oi-table';

  const colCount = sigHidden ? 2 : 3;
  const colgroup = document.createElement('colgroup');
  for (let ci = 0; ci < colCount; ci++) colgroup.appendChild(document.createElement('col'));
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headers = sigHidden
    ? ['Name', 'Description']
    : ['Name', 'Signature / Value', 'Description'];
  headers.forEach((text, i) => {
    const th = document.createElement('th');
    th.textContent = text;
    if (i < headers.length - 1) {
      const handle = document.createElement('div');
      handle.className = 'oi-col-handle';
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const colScope = handle.closest('.oi-col-scope') as HTMLElement | null;
        if (!colScope) return;
        const startX = e.clientX;
        const tableWidth = (handle.closest('table') as HTMLTableElement).getBoundingClientRect().width;
        const cssIdx = i;
        const nextCssIdx = sigHidden ? 2 : i + 1;
        const getW = (j: number) => parseFloat(colScope.style.getPropertyValue(`--oi-col${j}`)) || 33;
        const startPct = getW(cssIdx);
        const nextPct = getW(nextCssIdx);

        const onMove = (ev: MouseEvent) => {
          const delta = ((ev.clientX - startX) / tableWidth) * 100;
          const newCur = Math.max(8, startPct + delta);
          const newNext = Math.max(8, nextPct - delta);
          if (newCur + newNext <= startPct + nextPct + 0.5) {
            colScope.style.setProperty(`--oi-col${cssIdx}`, `${newCur}%`);
            colScope.style.setProperty(`--oi-col${nextCssIdx}`, `${newNext}%`);
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      th.appendChild(handle);
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  items.forEach((m) => tbody.appendChild(renderRow(m, options, sigHidden)));
  table.appendChild(tbody);

  scrollWrap.appendChild(table);
  body.appendChild(scrollWrap);
  section.append(summary, body);
  return section;
}

function renderRow(member: Member, options: MemberTableOptions, sigHidden = false): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'oi-table-row';
  tr.dataset['search'] = [member.name, member.path, member.doc_summary, ...(member.searchTerms ?? [])].join(' ');

  const nameTd = document.createElement('td');
  const nameCell = document.createElement('div');
  nameCell.className = 'oi-cell-name';
  nameCell.appendChild(iconEl(member.kind === 'punctuation' ? 'operator' : member.kind, options.pkg));

  const leaf = lastSegment(member.path);
  const parent = parentPath(member.path);
  const memberAccessPath = options.parentAccessPath && parent !== options.parentAccessPath
    && member.path.startsWith(`${options.parentAccessPath}.`)
    ? member.path
    : options.parentAccessPath
      ? `${options.parentAccessPath}.${leaf}`
      : member.path;

  const btn = document.createElement('a');
  btn.href = hrefFor(options.pkg, memberAccessPath);
  btn.className = 'oi-name-link' + (isSingleCharLabel(member.name) ? ' oi-char-hit' : '');
  btn.style.color = colorFor(member.kind === 'punctuation' ? 'operator' : member.kind, options.pkg);
  btn.textContent = member.name;
  btn.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    options.onNavigatePath(memberAccessPath);
  });
  nameCell.appendChild(btn);

  attachTooltip(btn, () => {
    const sig = displaySignature(member.name, member.signature);
    return (
      `<div class="oi-tooltip-sig">${escapeHtml(sig)}</div>` +
      `<div class="oi-tooltip-doc">${escapeHtml(member.doc_summary || 'No description available.')}</div>`
    );
  });
  nameTd.appendChild(nameCell);

  const docTd = document.createElement('td');
  docTd.className = 'oi-cell-doc';
  const docSpan = document.createElement('span');
  docSpan.className = 'oi-cell-text';
  docSpan.textContent = member.doc_summary;
  if (member.doc_summary) {
    attachTooltip(docSpan, () => `<div class="oi-tooltip-doc">${escapeHtml(member.doc_summary)}</div>`);
  }
  docTd.appendChild(docSpan);

  if (sigHidden) {
    tr.append(nameTd, docTd);
  } else {
    const sigTd = document.createElement('td');
    sigTd.className = 'oi-cell-sig';
    const sigText = member.signature ?? member.value_preview ?? '\u2014';
    const sigSpan = document.createElement('span');
    sigSpan.className = 'oi-cell-text';
    sigSpan.textContent = sigText;
    if (member.signature || member.value_preview) {
      attachTooltip(sigSpan, () => escapeHtml(member.signature || member.value_preview || ''));
    }
    sigTd.appendChild(sigSpan);
    tr.append(nameTd, sigTd, docTd);
  }
  return tr;
}
