import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { renderMarkdownProse } from './docMarkdown';

const THEME = 'dark-plus';

// Fine-grained bundle: only the Python grammar + dark-plus theme, using the
// pure-JS regex engine (no WASM fetch). Importing from `shiki` directly
// pulls in every language and theme Shiki ships (hundreds of chunks,
// ~10MB) even though we only ever highlight Python - this keeps the build
// small and the build itself fast.
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('shiki/themes/dark-plus.mjs')],
      langs: [import('shiki/langs/python.mjs')],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/**
 * Highlight a snippet of Python code as an HTML string using Shiki, the
 * same TextMate-grammar engine VS Code itself uses, with VS Code's own
 * `dark-plus` theme - this is what gets us pixel-accurate parity with the
 * editor's own syntax colors instead of approximating them by hand.
 */
export async function highlightPython(code: string): Promise<string> {
  if (!code) return '';
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, { lang: 'python', theme: THEME });
  } catch {
    // Shiki can throw on pathological input (e.g. incomplete syntax inside
    // a docstring example) - fall back to plain escaped text rather than
    // breaking the whole view.
    const div = document.createElement('div');
    div.textContent = code;
    return `<pre class="oi-hl-fallback"><code>${div.innerHTML}</code></pre>`;
  }
}

/**
 * Extract `>>> ...` doctest blocks (plus their expected output lines) and
 * fenced ```code``` blocks out of a docstring, highlighting each one, while
 * leaving the surrounding prose as plain text. Returns an HTML string safe
 * to assign to `innerHTML` (Shiki escapes code content itself; prose is
 * escaped here).
 */
const docSources = new WeakMap<HTMLElement, string>();
const docTokens = new WeakMap<HTMLElement, number>();

export function mountDocstring(el: HTMLElement, doc: string, markdown: boolean): void {
  docSources.set(el, doc);
  paintDocstring(el, doc, markdown);
}

export function remountDocstrings(root: ParentNode, markdown: boolean): void {
  root.querySelectorAll<HTMLElement>('.oi-function-doc').forEach((el) => {
    const doc = docSources.get(el);
    if (doc === undefined) return;
    paintDocstring(el, doc, markdown);
  });
}

function paintDocstring(el: HTMLElement, doc: string, markdown: boolean): void {
  const token = (docTokens.get(el) ?? 0) + 1;
  docTokens.set(el, token);
  void renderDocstring(doc, markdown).then((html) => {
    if (docTokens.get(el) !== token) return;
    el.innerHTML = html;
  });
}

export async function renderDocstring(doc: string, markdown = true): Promise<string> {
  if (!doc) return '<p class="oi-doc-empty">No docstring available.</p>';

  const lines = doc.split('\n');
  const blocks: { type: 'prose' | 'code'; text: string }[] = [];
  let current: string[] = [];
  let mode: 'prose' | 'doctest' | 'fenced' = 'prose';

  const flush = () => {
    if (current.length) {
      blocks.push({ type: mode === 'prose' ? 'prose' : 'code', text: current.join('\n') });
      current = [];
    }
  };

  for (const line of lines) {
    if (mode === 'prose' && line.trimStart().startsWith('>>>')) {
      flush();
      mode = 'doctest';
      current.push(line);
    } else if (mode === 'doctest') {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('>>>') || trimmed.startsWith('...') || (line.trim() !== '' && !line.match(/^\s*$/) && current.length && !trimmed.startsWith('>>>'))) {
        // Keep consuming continuation/output lines until a blank line ends the block.
        if (line.trim() === '') {
          flush();
          mode = 'prose';
        } else {
          current.push(line);
        }
      } else {
        flush();
        mode = 'prose';
        current.push(line);
      }
    } else if (mode === 'prose' && line.trimStart().startsWith('```')) {
      flush();
      mode = 'fenced';
    } else if (mode === 'fenced') {
      if (line.trimStart().startsWith('```')) {
        flush();
        mode = 'prose';
      } else {
        current.push(line);
      }
    } else {
      current.push(line);
    }
  }
  flush();

  const escape = (s: string) => {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  };

  const parts = await Promise.all(
    blocks.map(async (block) => {
      if (block.type === 'code') {
        const html = await highlightPython(block.text);
        return `<div class="oi-doc-code">${html}</div>`;
      }
      if (!block.text.trim()) return '';
      if (markdown) return renderMarkdownProse(block.text);
      return `<p class="oi-doc-prose">${escape(block.text).replace(/\n/g, '<br/>')}</p>`;
    }),
  );

  return parts.join('\n');
}
