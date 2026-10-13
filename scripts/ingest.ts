#!/usr/bin/env npx tsx
/**
 * Fetch a Sphinx objects.inv (or a JSON cache file) and write
 * pyDoctor/public/cache/<name>.json plus an index.json entry.
 *
 * Usage: npm run ingest -- <package> <url>
 * Example: npm run ingest -- numpy https://numpy.org/doc/stable/objects.inv
 */
import { inflateRawSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inventoryPayloadOffset,
  looksLikeInventory,
  looksLikeJson,
  parseInventoryBody,
} from '../src/cache/inventory.ts';
import { parsePackageCache } from '../src/cache/schema.ts';
import type { CacheIndex, PackageCache } from '../src/types.ts';
import { shardCacheFile } from './shard-cache.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  const url = process.argv[3]?.trim();
  if (!name || !url) {
    console.error('Usage: npm run ingest -- <package> <objects.inv-or-json-url>');
    process.exit(1);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let cache: PackageCache;
  if (looksLikeJson(buf)) {
    cache = parsePackageCache(JSON.parse(new TextDecoder().decode(buf)), name);
    cache.package = name;
    cache.sourceUrl = cache.sourceUrl || url;
  } else if (looksLikeInventory(buf)) {
    const headerText = new TextDecoder().decode(buf.slice(0, 512));
    if (!headerText.startsWith('# Sphinx inventory version 2')) {
      throw new Error('Only Sphinx objects.inv version 2 is supported.');
    }
    const payload = buf.slice(inventoryPayloadOffset(buf));
    let inflated: Uint8Array;
    try {
      inflated = new Uint8Array(inflateSync(payload));
    } catch {
      inflated = new Uint8Array(inflateRawSync(payload));
    }
    cache = parseInventoryBody(new TextDecoder().decode(inflated), name, url);
  } else {
    throw new Error('URL was neither a Sphinx objects.inv file nor a JSON cache file.');
  }

  await mkdir(cacheDir, { recursive: true });
  const file = `${name}.json`;
  const filePath = join(cacheDir, file);
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  const sharded = await shardCacheFile(filePath, 2 * 1024 * 1024);

  const indexPath = join(cacheDir, 'index.json');
  let index: CacheIndex = { packages: [] };
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8')) as CacheIndex;
    if (!Array.isArray(index.packages)) index = { packages: [] };
  } catch {
    index = { packages: [] };
  }
  const rest = index.packages.filter((p) => p.name !== name);
  const previous = index.packages.find((p) => p.name === name);
  const entry: CacheIndex['packages'][number] = { name, file };
  if (previous?.loadByDefault) entry.loadByDefault = true;
  if (previous?.pinned) entry.pinned = true;
  if (cache.generatedAt) entry.generatedAt = cache.generatedAt;
  if (sharded.sharded) entry.sharded = true;
  rest.push(entry);
  rest.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(indexPath, `${JSON.stringify({ packages: rest }, null, 2)}\n`, 'utf8');

  console.log(`Wrote public/cache/${file} (${cache.entries.length} entries${sharded.sharded ? ', sharded' : ''})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
