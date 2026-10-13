import type { ObjectDescription } from '../types';
import { highlightPython, mountDocstring } from '../highlight';
import { getDocMarkdown } from '../markdownPref';
import { hrefFor } from '../router';
import { displaySignature } from '../utils';

export interface FunctionViewOptions {
  onNavigatePath: (path: string) => void;
  currentPath: string;
  pkg: string;
}

export interface FunctionViewParts {
  sigRow: HTMLElement;
  body: HTMLElement;
}

export function renderFunctionView(obj: ObjectDescription, options: FunctionViewOptions): FunctionViewParts {
  const sigRow = document.createElement('div');
  sigRow.className = 'oi-sig-row';

  const sigLine = document.createElement('div');
  sigLine.className = 'oi-function-signature';
  const sigSource = displaySignature(obj.dispname || obj.name, obj.signature);
  highlightPython(sigSource).then((html) => { sigLine.innerHTML = html; });
  sigLine.textContent = sigSource;
  sigRow.appendChild(sigLine);

  if (obj.docUri) {
    const docsLink = document.createElement('a');
    docsLink.className = 'oi-docs-link';
    docsLink.href = obj.docUri;
    docsLink.target = '_blank';
    docsLink.rel = 'noopener noreferrer';
    docsLink.textContent = 'Open official docs';
    sigRow.appendChild(docsLink);
  }

  const root = document.createElement('div');
  root.className = 'oi-function-view';

  const docSection = document.createElement('div');
  docSection.className = 'oi-section';
  docSection.dataset.viewKey = 'docstring';
  docSection.dataset.open = 'true';

  const docSummaryEl = document.createElement('div');
  docSummaryEl.className = 'oi-section-summary';
  const chevron = document.createElement('span');
  chevron.className = 'codicon codicon-chevron-down oi-chevron';
  const docLabel = document.createElement('span');
  docLabel.textContent = 'Docstring';
  docSummaryEl.append(chevron, docLabel);

  const docBody = document.createElement('div');
  docBody.className = 'oi-section-body';
  docBody.style.display = 'block';

  const docWrap = document.createElement('div');
  docWrap.className = 'oi-function-doc';
  mountDocstring(docWrap, obj.doc, getDocMarkdown());
  docBody.appendChild(docWrap);

  docSummaryEl.addEventListener('click', () => {
    const isOpen = docSection.dataset['open'] === 'true';
    docSection.dataset['open'] = isOpen ? 'false' : 'true';
    docBody.style.display = isOpen ? 'none' : 'block';
  });

  docSection.append(docSummaryEl, docBody);
  root.appendChild(docSection);

  if (obj.aliases.length > 1) {
    const aliasWrap = document.createElement('div');
    aliasWrap.className = 'oi-aliases';
    const title = document.createElement('div');
    title.className = 'oi-aliases-title';
    title.textContent = 'Also reachable as';
    aliasWrap.appendChild(title);
    for (const alias of obj.aliases) {
      if (alias === options.currentPath) continue;
      const btn = document.createElement('a');
      btn.href = hrefFor(options.pkg, alias);
      btn.className = 'oi-alias-item';
      btn.textContent = alias;
      btn.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        options.onNavigatePath(alias);
      });
      aliasWrap.appendChild(btn);
    }
    root.appendChild(aliasWrap);
  }

  return { sigRow, body: root };
}
