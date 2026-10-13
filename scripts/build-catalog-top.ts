#!/usr/bin/env npx tsx
/**
 * Bake a slim top-level third-party search index and patch aliases on index.json.
 *
 * Usage: npm run catalog-top
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidKind } from '../src/cache/schema.ts';
import type { CacheIndex, CatalogTop, CatalogTopEntry, Kind } from '../src/types.ts';
import { aliasesFor } from './package-aliases.ts';

const SKIP_FILES = new Set(['stdlib.json', 'builtins.json', 'demo.json', 'syntax.json', 'index.json', 'catalog-top.json', 'pypi-index.json']);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');

function lastSegment(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? path : path.slice(i + 1);
}

function isTopLevel(pkg: string, path: string): boolean {
  if (path === pkg) return false;
  const prefix = `${pkg}.`;
  if (!path.startsWith(prefix)) return false;
  return !path.slice(prefix.length).includes('.');
}

export async function buildCatalogTop(dir = cacheDir): Promise<void> {
  const indexPath = join(dir, 'index.json');
  const raw = JSON.parse(await readFile(indexPath, 'utf8')) as CacheIndex;
  if (!raw || !Array.isArray(raw.packages)) {
    throw new Error('index.json is missing a packages array.');
  }

  const entries: CatalogTopEntry[] = [];
  const seen = new Set<string>();

  for (const pkg of raw.packages) {
    const aliases = aliasesFor(pkg.name);
    if (aliases) pkg.aliases = aliases;
    else delete pkg.aliases;

    if (SKIP_FILES.has(pkg.file)) continue;

    let parsed: { entries?: unknown };
    try {
      parsed = JSON.parse(await readFile(join(dir, pkg.file), 'utf8')) as { entries?: unknown };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  skip ${pkg.name}: ${message}`);
      continue;
    }
    if (!Array.isArray(parsed.entries)) continue;

    for (const item of parsed.entries) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.path !== 'string' || typeof row.kind !== 'string') continue;
      if (!isValidKind(row.kind)) continue;
      if (!isTopLevel(pkg.name, row.path)) continue;
      if (lastSegment(row.path).startsWith('_')) continue;
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      const entry: CatalogTopEntry = {
        path: row.path,
        package: pkg.name,
        kind: row.kind as Kind,
      };
      if (typeof row.doc_summary === 'string' && row.doc_summary) {
        entry.doc_summary = row.doc_summary;
      }
      entries.push(entry);
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  const payload: CatalogTop = {
    generatedAt: new Date().toISOString(),
    entries,
  };
  await writeFile(join(dir, 'catalog-top.json'), `${JSON.stringify(payload)}\n`, 'utf8');
  await writeFile(indexPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`Catalog top: ${entries.length} entries; aliases patched on index.json.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildCatalogTop().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
