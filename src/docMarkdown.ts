/**
 * Render docstring prose as HTML.
 * Handles CommonMark headings, inline code, emphasis, links, and lists,
 * plus the section, field, and grid-table forms used in Python docstrings.
 * Code fences and doctests are split out before this runs.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DIRECTIVES: Record<string, string> = {
  versionadded: 'Added in',
  versionchanged: 'Changed in',
  deprecated: 'Deprecated',
  note: 'Note',
  warning: 'Warning',
};

function inline(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('``', i)) {
      const end = src.indexOf('``', i + 2);
      if (end !== -1) {
        out += `<code>${escapeHtml(src.slice(i + 2, end))}</code>`;
        i = end + 2;
        continue;
      }
    }
    if (src[i] === ':') {
      const role = /^:[\w-]+:`([^`]+)`/.exec(src.slice(i));
      if (role) {
        out += `<code>${escapeHtml(role[1])}</code>`;
        i += role[0].length;
        continue;
      }
    }
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHtml(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(src.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (src[i] === '*' && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== '*') {
      const end = src.indexOf('*', i + 1);
      if (end > i + 1 && !src.slice(i + 1, end).includes(' ')) {
        out += `<em>${inline(src.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (src[i] === '[') {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(src.slice(i));
      if (link) {
        out += `<a href="${escapeHtml(link[2])}" target="_blank" rel="noopener noreferrer">${inline(link[1])}</a>`;
        i += link[0].length;
        continue;
      }
    }
    out += escapeHtml(src[i]!);
    i++;
  }
  return out;
}

function isTableRule(line: string): boolean {
  return /^=+(?:\s+=+)+\s*$/.test(line.trim());
}

function isHeadingUnderline(line: string): boolean {
  return /^[-=]{3,}\s*$/.test(line.trim()) && !line.trim().includes(' ');
}

function isAtx(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

function isDirective(line: string): boolean {
  return /^\.\.\s+\w+::/.test(line.trim());
}

function isListItem(line: string): boolean {
  return /^([-*]|\d+\.)\s+\S/.test(line);
}

function isField(line: string): boolean {
  return /^\S.*\s:\s+\S/.test(line);
}

function isSpecialStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return false;
  if (isTableRule(line) || isAtx(line) || isDirective(line) || isListItem(line) || isField(line)) return true;
  const next = lines[index + 1];
  return Boolean(next && isHeadingUnderline(next) && !/^\s/.test(line));
}

function columnSpans(rule: string): number[] {
  const starts: number[] = [];
  const re = /=+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rule))) starts.push(match.index);
  return starts;
}

function cellsFor(line: string, starts: number[]): string[] {
  return starts.map((start, index) => {
    const end = index === starts.length - 1 ? line.length : starts[index + 1]!;
    return line.slice(start, end).trim();
  });
}

function renderTable(rows: string[][], headerCount: number): string {
  const head = headerCount > 0 ? rows.slice(0, headerCount) : [];
  const body = rows.slice(headerCount);
  const headHtml = head.map((row) =>
    `<tr>${row.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>`,
  ).join('');
  const bodyHtml = body.map((row) =>
    `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`,
  ).join('');
  return `<table class="oi-doc-table">${headHtml ? `<thead>${headHtml}</thead>` : ''}<tbody>${bodyHtml}</tbody></table>`;
}

function dedent(lines: string[]): string {
  const widths = lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)?.[0].length ?? 0);
  if (!widths.length) return '';
  const min = Math.min(...widths);
  return lines.map((line) => (line.trim() ? line.slice(min) : '')).join('\n');
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const ordered = /^\s*\d+\.\s/.test(lines[start] ?? '');
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const match = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i] ?? '');
    if (!match || match[1]!.length > 2) break;
    const parts = [match[3]!];
    i++;
    while (i < lines.length && /^\s+\S/.test(lines[i] ?? '') && !isListItem(lines[i] ?? '')) {
      parts.push((lines[i] ?? '').trim());
      i++;
    }
    while (i < lines.length && !(lines[i] ?? '').trim()) {
      const ahead = lines[i + 1] ?? '';
      if (isListItem(ahead)) {
        i++;
        break;
      }
      break;
    }
    items.push(inline(parts.join(' ')));
  }
  const tag = ordered ? 'ol' : 'ul';
  return {
    html: `<${tag} class="oi-doc-list">${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`,
    next: i,
  };
}

export function renderMarkdownProse(text: string, depth = 0): string {
  if (!text.trim()) return '';
  if (depth > 6) return `<p class="oi-doc-prose">${escapeHtml(text)}</p>`;

  const lines = text.split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }

    if (isTableRule(line)) {
      const starts = columnSpans(line);
      const rows: string[][] = [];
      let headerCount = 0;
      let seenHeaderRule = false;
      i++;
      while (i < lines.length) {
        const row = lines[i] ?? '';
        if (isTableRule(row)) {
          if (!seenHeaderRule && rows.length > 0) {
            headerCount = rows.length;
            seenHeaderRule = true;
            i++;
            continue;
          }
          i++;
          break;
        }
        if (!row.trim()) break;
        rows.push(cellsFor(row, starts));
        i++;
      }
      if (rows.length) html.push(renderTable(rows, headerCount));
      continue;
    }

    const next = lines[i + 1];
    if (next && isHeadingUnderline(next) && !/^\s/.test(line)) {
      const level = next.trim().startsWith('=') ? 'oi-doc-h2' : 'oi-doc-h3';
      html.push(`<div class="oi-doc-heading ${level}">${inline(line.trim())}</div>`);
      i += 2;
      continue;
    }

    const atx = /^(#{1,6})\s+(.*)$/.exec(line);
    if (atx) {
      const level = atx[1]!.length <= 2 ? 'oi-doc-h2' : 'oi-doc-h3';
      html.push(`<div class="oi-doc-heading ${level}">${inline(atx[2]!.trim())}</div>`);
      i++;
      continue;
    }

    const directive = /^\.\.\s+(\w+)::\s*(.*)$/.exec(line.trim());
    if (directive) {
      const name = directive[1]!.toLowerCase();
      const label = DIRECTIVES[name] ?? name;
      const rest = directive[2]?.trim() ? ` ${inline(directive[2].trim())}` : '';
      html.push(`<p class="oi-doc-note">${escapeHtml(label)}${rest}</p>`);
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i] ?? '')) i++;
      continue;
    }

    if (isListItem(line)) {
      const list = renderList(lines, i);
      html.push(list.html);
      i = list.next;
      continue;
    }

    if (isField(line)) {
      const match = /^([^:]+?)\s:\s+(.+)$/.exec(line);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i] ?? '';
        if (!bodyLine.trim()) {
          const ahead = lines.slice(i + 1).find((candidate) => candidate.trim());
          if (ahead && /^\s/.test(ahead)) {
            body.push('');
            i++;
            continue;
          }
          break;
        }
        if (!/^\s/.test(bodyLine)) break;
        body.push(bodyLine);
        i++;
      }
      const bodyHtml = renderMarkdownProse(dedent(body), depth + 1);
      html.push(
        `<div class="oi-doc-field"><div class="oi-doc-field-sig"><code class="oi-doc-field-name">${inline(match?.[1]?.trim() ?? line)}</code><span class="oi-doc-field-type">${inline(match?.[2]?.trim() ?? '')}</span></div>${bodyHtml ? `<div class="oi-doc-field-body">${bodyHtml}</div>` : ''}</div>`,
      );
      continue;
    }

    if (/^\s/.test(line)) {
      const chunk: string[] = [];
      while (i < lines.length && ((lines[i] ?? '').trim() === '' || /^\s/.test(lines[i] ?? ''))) {
        chunk.push(lines[i] ?? '');
        i++;
      }
      const nested = renderMarkdownProse(dedent(chunk), depth + 1);
      if (nested) html.push(nested);
      continue;
    }

    const parts = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] ?? '').trim()) {
      const current = lines[i] ?? '';
      if (/^\s/.test(current)) {
        if (isTableRule(current)) break;
        parts.push(current.trim());
        i++;
        continue;
      }
      if (isSpecialStart(lines, i)) break;
      parts.push(current.trim());
      i++;
    }
    let paragraph = parts.join(' ');
    if (paragraph.endsWith('::')) {
      paragraph = paragraph.slice(0, -2).replace(/:$/, '');
      const literal: string[] = [];
      while (i < lines.length && ((lines[i] ?? '').trim() === '' || /^\s/.test(lines[i] ?? ''))) {
        if ((lines[i] ?? '').trim()) literal.push(lines[i] ?? '');
        else if (literal.length) break;
        i++;
      }
      const prose = paragraph.trim() ? `<p class="oi-doc-prose">${inline(paragraph.trim())}</p>` : '';
      const code = literal.length
        ? `<pre class="oi-doc-literal"><code>${escapeHtml(dedent(literal))}</code></pre>`
        : '';
      html.push(prose + code);
      continue;
    }
    html.push(`<p class="oi-doc-prose">${inline(paragraph)}</p>`);
  }

  return html.join('\n');
}
