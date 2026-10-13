import type { PypiInfo } from '../types';

export interface PypiCardOptions {
  emptyInventory?: boolean;
  busy?: boolean;
  error?: string | null;
  onTryInventory?: () => void;
  onIngestPackage?: () => void;
}

export function renderPypiCard(info: PypiInfo, options: PypiCardOptions = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'oi-pypi-card';

  if (options.emptyInventory) {
    const notice = document.createElement('div');
    notice.className = 'oi-pypi-notice';
    notice.textContent =
      'This Sphinx inventory has no Python API objects (guide pages only).';
    root.appendChild(notice);
  }

  const header = document.createElement('div');
  header.className = 'oi-header';

  const title = document.createElement('div');
  title.className = 'oi-header-title';
  const mark = document.createElement('span');
  mark.className = 'oi-pypi-badge';
  mark.textContent = 'PyPI';
  const name = document.createElement('span');
  name.textContent = info.name;
  title.append(mark, name);
  if (info.version) {
    const ver = document.createElement('span');
    ver.className = 'oi-header-subtitle';
    ver.textContent = info.version;
    title.appendChild(ver);
  }
  header.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'oi-header-subtitle';
  meta.textContent = 'Package metadata from PyPI — not a loaded API.';
  header.appendChild(meta);

  if (info.summary) {
    const summary = document.createElement('div');
    summary.className = 'oi-header-summary';
    summary.textContent = info.summary;
    header.appendChild(summary);
  }
  root.appendChild(header);

  const links = document.createElement('div');
  links.className = 'oi-pypi-links';
  links.appendChild(extLink(info.pypiUrl, 'Open on PyPI'));
  if (info.homeUrl && info.homeUrl !== info.pypiUrl) {
    links.appendChild(extLink(info.homeUrl, 'Homepage'));
  }
  if (info.docsUrl && info.docsUrl !== info.homeUrl) {
    links.appendChild(extLink(info.docsUrl, 'Documentation'));
  }
  root.appendChild(links);

  const actions = document.createElement('div');
  actions.className = 'oi-pypi-actions';
  if (info.inventoryUrl && options.onTryInventory) {
    const tryBtn = document.createElement('button');
    tryBtn.type = 'button';
    tryBtn.className = 'oi-sidebar-add-btn';
    tryBtn.disabled = Boolean(options.busy);
    tryBtn.textContent = options.busy ? 'Trying\u2026' : 'Try API docs';
    tryBtn.addEventListener('click', () => options.onTryInventory?.());
    actions.appendChild(tryBtn);
  }
  if (options.onIngestPackage) {
    const ingestBtn = document.createElement('button');
    ingestBtn.type = 'button';
    ingestBtn.className = 'oi-sidebar-add-btn';
    ingestBtn.disabled = Boolean(options.busy);
    ingestBtn.textContent = 'Ingest package';
    ingestBtn.addEventListener('click', () => options.onIngestPackage?.());
    actions.appendChild(ingestBtn);
  }
  if (actions.childNodes.length) root.appendChild(actions);

  if (options.error) {
    const err = document.createElement('div');
    err.className = 'oi-sidebar-add-error';
    err.style.display = 'block';
    err.textContent = options.error;
    root.appendChild(err);
  }

  if (info.description) {
    const desc = document.createElement('pre');
    desc.className = 'oi-pypi-desc';
    desc.textContent = info.description;
    root.appendChild(desc);
  }

  return root;
}

function extLink(href: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'oi-docs-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}
