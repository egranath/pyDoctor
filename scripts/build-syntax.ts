#!/usr/bin/env npx tsx
/**
 * Compile the hand-authored syntax index into public/cache/syntax.json.
 *
 * Usage: npm run syntax
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PackageCache } from '../src/types.ts';
import { compileSyntax } from './syntax-data.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');

export async function buildSyntax(outDir = cacheDir, generatedAt?: string): Promise<PackageCache> {
  const cache = compileSyntax(generatedAt);
  const dest = join(outDir, 'syntax.json');
  await writeFile(dest, `${JSON.stringify(cache)}\n`, 'utf8');
  return cache;
}

const invokedDirectly = !!process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  buildSyntax()
    .then((cache) => {
      console.log(`Wrote syntax.json (${cache.entries.length} entries).`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
