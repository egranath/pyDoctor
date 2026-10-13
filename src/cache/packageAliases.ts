/** Canonical package name → search aliases. Suggestions always use the canonical name. */
export const PACKAGE_ALIASES: Record<string, string[]> = {
  sklearn: ['scikit-learn', 'scikit_learn'],
  PIL: ['Pillow', 'pillow'],
  bs4: ['BeautifulSoup', 'beautifulsoup4'],
};

export function aliasesFor(name: string): string[] | undefined {
  const aliases = PACKAGE_ALIASES[name];
  return aliases && aliases.length > 0 ? aliases : undefined;
}

/** PEP 503 normalized name (`scikit-learn` ≡ `scikit_learn`). */
export function pep503Normalize(name: string): string {
  return name.trim().replace(/[-_.]+/g, '-').toLowerCase();
}

/** Dist names to try on Warehouse for a typed query (canonical + aliases). */
export function lookupNamesFor(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = pep503Normalize(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  add(q);
  const qn = pep503Normalize(q);
  const ql = q.toLowerCase();
  for (const [canon, aliases] of Object.entries(PACKAGE_ALIASES)) {
    const all = [canon, ...aliases];
    if (all.some((alias) => alias.toLowerCase() === ql || pep503Normalize(alias) === qn)) {
      for (const alias of all) add(alias);
    }
  }
  return names;
}
