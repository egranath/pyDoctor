export { lastSegment, parentPath } from './cache/paths';

/** Call sigs start with `(`. Operators / keywords store the full form instead. */
export function displaySignature(name: string, signature: string | null | undefined): string {
  if (!signature) return name;
  if (signature.startsWith('(')) return `${name}${signature}`;
  return signature;
}

/** True when a displayed name is a single glyph (operators, punctuation). */
export function isSingleCharLabel(text: string): boolean {
  return [...text].length === 1;
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function cacheAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${relativePath.replace(/^\//, '')}`;
}
