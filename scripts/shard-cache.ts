#!/usr/bin/env npx tsx
/**
 * Split large PackageCache JSON files into a small root + per-module shards.
 *
 * Usage: npm run shard-cache
 *        npm run shard-cache -- --min-bytes 2000000
 *
 * Small packages and stdlib.json stay single-file. Existing sharded roots are skipped.
 * Large files (pandas, sympy) are streamed so Node does not JSON.parse a 900MB blob.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackageCache } from '../src/cache/schema.ts';
import {
  MAX_SHARD_BYTES,
  memberIdAtLevel,
  shardFileName,
  shardIdAtLevel,
  splitPackageCache,
} from '../src/cache/shards.ts';
import type { CacheEntry, CacheIndex, PackageCache, ShardManifestEntry } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');

const SKIP_FILES = new Set(['index.json', 'stdlib.json', 'demo.json', 'syntax.json', 'catalog-top.json', 'pypi-index.json']);
const MEMORY_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_BYTES = 2 * 1024 * 1024;
const MARKER = Buffer.from('"entries":[');

function minBytesFromArgv(): number {
  const idx = process.argv.indexOf('--min-bytes');
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MIN_BYTES;
}

function parseHeaderMeta(buf: Buffer): { package?: string; sourceUrl?: string; generatedAt?: string; sharded: boolean; bundle: boolean } {
  const text = buf.subarray(0, Math.min(buf.length, 32 * 1024)).toString('utf8');
  const pkg = text.match(/"package"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const src = text.match(/"sourceUrl"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const gen = text.match(/"generatedAt"\s*:\s*"((?:\\.|[^"\\])*)"/);
  return {
    package: pkg ? JSON.parse(`"${pkg[1]}"`) as string : undefined,
    sourceUrl: src ? JSON.parse(`"${src[1]}"`) as string : undefined,
    generatedAt: gen ? JSON.parse(`"${gen[1]}"`) as string : undefined,
    sharded: /"shards"\s*:\s*\{/.test(text),
    bundle: /"packages"\s*:\s*\[/.test(text) && !/"entries"\s*:\s*\[/.test(text.slice(0, 200)),
  };
}

async function peekFile(path: string): Promise<ReturnType<typeof parseHeaderMeta> & { size: number }> {
  const { size } = await stat(path);
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 32 * 1024));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return { ...parseHeaderMeta(buf.subarray(0, bytesRead)), size };
  } finally {
    await handle.close();
  }
}

function extractPath(json: string): string | null {
  const m = json.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

async function* iterateEntryJson(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  let pending = Buffer.alloc(0);
  let seeking = true;
  let inObject = false;
  let inString = false;
  let escape = false;
  let depth = 0;
  const parts: Buffer[] = [];
  let objBytes = 0;
  const MAX_OBJECT = 48 * 1024 * 1024;

  const consume = function* (chunk: Buffer): Generator<string> {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let i = 0;
    if (seeking) {
      const idx = pending.indexOf(MARKER);
      if (idx === -1) {
        if (pending.length > MARKER.length) pending = pending.subarray(pending.length - MARKER.length);
        return;
      }
      i = idx + MARKER.length;
      seeking = false;
    }
    while (i < pending.length) {
      const c = pending[i]!;
      if (!inObject) {
        if (c === 0x7b) {
          inObject = true;
          depth = 1;
          inString = false;
          escape = false;
          parts.length = 0;
          objBytes = 0;
          const start = i;
          i++;
          while (i < pending.length) {
            const d = pending[i]!;
            if (inString) {
              if (escape) escape = false;
              else if (d === 0x5c) escape = true;
              else if (d === 0x22) inString = false;
            } else if (d === 0x22) inString = true;
            else if (d === 0x7b) depth++;
            else if (d === 0x7d) {
              depth--;
              if (depth === 0) {
                const json = pending.subarray(start, i + 1).toString('utf8');
                inObject = false;
                i++;
                yield json;
                break;
              }
            }
            i++;
          }
          if (inObject) {
            parts.push(pending.subarray(start));
            objBytes = pending.length - start;
            pending = Buffer.alloc(0);
            return;
          }
          continue;
        }
        if (c === 0x5d) return;
        i++;
        continue;
      }
      if (inString) {
        if (escape) escape = false;
        else if (c === 0x5c) escape = true;
        else if (c === 0x22) inString = false;
        i++;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b) depth++;
      else if (c === 0x7d) {
        depth--;
        if (depth === 0) {
          parts.push(pending.subarray(0, i + 1));
          objBytes += i + 1;
          const json = Buffer.concat(parts).toString('utf8');
          parts.length = 0;
          objBytes = 0;
          inObject = false;
          pending = pending.subarray(i + 1);
          i = 0;
          yield json;
          continue;
        }
      }
      i++;
    }
    if (inObject) {
      parts.push(pending);
      objBytes += pending.length;
      if (objBytes > MAX_OBJECT) {
        throw new Error(`Entry exceeded ${MAX_OBJECT} bytes while streaming ${filePath}`);
      }
      pending = Buffer.alloc(0);
    } else if (i > 0) {
      pending = pending.subarray(i);
    }
  };

  for await (const chunk of stream) {
    yield* consume(chunk as Buffer);
  }
  if (inObject && parts.length) {
    throw new Error(`Truncated cache JSON in ${filePath}`);
  }
}

async function writeMinified(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`, 'utf8');
}

async function shardInMemory(
  filePath: string,
  cache: PackageCache,
  parentShard: string | null = null,
): Promise<{ shards: number; rootEntries: number; manifest: Record<string, ShardManifestEntry> } | null> {
  const split = splitPackageCache(cache, parentShard);
  if (!split) return null;
  const pkg = cache.package;
  await mkdir(join(cacheDir, pkg), { recursive: true });
  const manifest: Record<string, ShardManifestEntry> = {};
  for (const [id, shard] of split.shards) {
    const file = shardFileName(pkg, id);
    await writeMinified(join(cacheDir, file), shard);
    manifest[id] = { file, count: shard.entries.length };
  }
  const tmp = `${filePath}.root.tmp`;
  await writeMinified(tmp, split.root);
  await rename(tmp, filePath);
  return { shards: split.shards.size, rootEntries: split.root.entries.length, manifest };
}

type ShardWriter = { stream: ReturnType<typeof createWriteStream>; count: number; path: string };

async function shardStreaming(
  filePath: string,
  meta: { package: string; sourceUrl: string; generatedAt: string },
  parentShard: string | null = null,
): Promise<{ shards: number; rootEntries: number; manifest: Record<string, ShardManifestEntry> }> {
  const pkg = meta.package;
  const dir = join(cacheDir, pkg);
  await mkdir(dir, { recursive: true });
  const ndjsonDir = join(dir, parentShard ? `.ndjson-${parentShard.replace(/[^A-Za-z0-9._-]+/g, '_')}` : '.ndjson');
  await mkdir(ndjsonDir, { recursive: true });

  const rootEntries: CacheEntry[] = [];
  const topLevel = new Map<string, CacheEntry>();
  const writers = new Map<string, ShardWriter>();

  const writerFor = (id: string): ShardWriter => {
    let w = writers.get(id);
    if (w) return w;
    const path = join(ndjsonDir, `${id.replace(/[^A-Za-z0-9._-]+/g, '_')}.ndjson`);
    w = { stream: createWriteStream(path), count: 0, path };
    writers.set(id, w);
    return w;
  };

  let seen = 0;
  const label = parentShard ? `${pkg}.${parentShard}` : pkg;
  for await (const json of iterateEntryJson(filePath)) {
    const path = extractPath(json);
    if (!path) continue;
    const shard = shardIdAtLevel(pkg, path, parentShard);
    if (shard === null) {
      let entry: CacheEntry;
      try {
        entry = JSON.parse(json) as CacheEntry;
      } catch {
        continue;
      }
      rootEntries.push(entry);
      const id = memberIdAtLevel(pkg, path, parentShard);
      if (id) topLevel.set(id, entry);
    } else {
      const w = writerFor(shard);
      w.stream.write(json);
      w.stream.write('\n');
      w.count++;
    }
    seen++;
    if (seen % 100000 === 0) console.log(`  … ${label}: ${seen} entries`);
  }

  const manifest: Record<string, ShardManifestEntry> = {};
  for (const [id, w] of writers) {
    await new Promise<void>((resolve, reject) => {
      w.stream.end(() => resolve());
      w.stream.on('error', reject);
    });
    const head = topLevel.get(id);
    const outPath = join(cacheDir, shardFileName(pkg, id));
    await mkdir(dirname(outPath), { recursive: true });
    await writeShardFromNdjson(outPath, {
      package: pkg,
      sourceUrl: meta.sourceUrl,
      generatedAt: meta.generatedAt,
    }, w.path, head);
    manifest[id] = { file: shardFileName(pkg, id), count: w.count + (head ? 1 : 0) };
  }

  const root: PackageCache = parentShard
    ? {
        package: pkg,
        sourceUrl: meta.sourceUrl,
        generatedAt: meta.generatedAt,
        entries: rootEntries,
      }
    : {
        package: pkg,
        sourceUrl: meta.sourceUrl,
        generatedAt: meta.generatedAt,
        shards: manifest,
        entries: rootEntries,
      };
  const tmp = `${filePath}.root.tmp`;
  await writeMinified(tmp, root);
  await rename(tmp, filePath);
  await rm(ndjsonDir, { recursive: true, force: true });
  return { shards: writers.size, rootEntries: rootEntries.length, manifest };
}

async function splitShardFile(
  shardPath: string,
  meta: { package: string; sourceUrl: string; generatedAt: string },
  parentShard: string,
): Promise<{ rootEntries: number; manifest: Record<string, ShardManifestEntry> } | null> {
  const size = (await stat(shardPath)).size;
  if (size <= MEMORY_MAX_BYTES) {
    const cache = parsePackageCache(JSON.parse(await readFile(shardPath, 'utf8')), meta.package);
    const result = await shardInMemory(shardPath, cache, parentShard);
    if (!result) return null;
    return { rootEntries: result.rootEntries, manifest: result.manifest };
  }
  const result = await shardStreaming(shardPath, meta, parentShard);
  if (result.shards === 0) return null;
  return { rootEntries: result.rootEntries, manifest: result.manifest };
}

async function refineLargeShards(rootPath: string): Promise<number> {
  const cache = parsePackageCache(JSON.parse(await readFile(rootPath, 'utf8')));
  if (!cache.shards) return 0;
  let extra = 0;
  const queue: Array<[string, ShardManifestEntry]> = Object.entries(cache.shards);
  const meta = { package: cache.package, sourceUrl: cache.sourceUrl, generatedAt: cache.generatedAt };
  while (queue.length) {
    const [id, info] = queue.pop()!;
    const shardPath = join(cacheDir, info.file);
    let size = 0;
    try {
      size = (await stat(shardPath)).size;
    } catch {
      continue;
    }
    if (size <= MAX_SHARD_BYTES) continue;
    console.log(`  splitting oversized ${cache.package}.${id} (${Math.round(size / 1024 / 1024)}MB)…`);
    const result = await splitShardFile(shardPath, meta, id);
    if (!result) continue;
    extra += Object.keys(result.manifest).length;
    cache.shards[id] = { file: info.file, count: result.rootEntries };
    for (const [subId, sub] of Object.entries(result.manifest)) {
      cache.shards[subId] = sub;
      queue.push([subId, sub]);
    }
    console.log(`    ${id}: root ${result.rootEntries} entries, +${Object.keys(result.manifest).length} subshards`);
  }
  if (extra > 0) {
    await writeMinified(rootPath, {
      package: cache.package,
      sourceUrl: cache.sourceUrl,
      generatedAt: cache.generatedAt,
      shards: cache.shards,
      entries: cache.entries,
    });
  }
  return extra;
}

async function writeShardFromNdjson(
  outPath: string,
  meta: { package: string; sourceUrl: string; generatedAt: string },
  ndjsonPath: string,
  head?: CacheEntry,
): Promise<void> {
  const out = createWriteStream(outPath);
  const header = JSON.stringify({
    package: meta.package,
    sourceUrl: meta.sourceUrl,
    generatedAt: meta.generatedAt,
  }).slice(0, -1);
  out.write(`${header},"entries":[`);
  let first = true;
  if (head) {
    out.write(JSON.stringify(head));
    first = false;
  }
  const input = createReadStream(ndjsonPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
  let carry = '';
  for await (const chunk of input) {
    carry += chunk as string;
    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (line) {
        if (!first) out.write(',');
        first = false;
        out.write(line);
      }
      nl = carry.indexOf('\n');
    }
    if (carry.length > 8 * 1024 * 1024) {
      throw new Error(`NDJSON line too long in ${ndjsonPath}`);
    }
  }
  const last = carry.trim();
  if (last) {
    if (!first) out.write(',');
    out.write(last);
  }
  await new Promise<void>((resolve, reject) => {
    out.end(']}\n', () => resolve());
    out.on('error', reject);
  });
}

export async function shardCacheFile(
  filePath: string,
  minBytes: number,
): Promise<{ name: string; sharded: boolean; skipped?: string; shards?: number; rootEntries?: number }> {
  const peek = await peekFile(filePath);
  const name = peek.package || basenameNoExt(filePath);
  if (peek.bundle) return { name, sharded: false, skipped: 'bundle' };
  if (peek.sharded) {
    const extra = await refineLargeShards(filePath);
    if (extra > 0) console.log(`  ${name}: split ${extra} oversized subshards`);
    return { name, sharded: true, skipped: extra > 0 ? undefined : 'already-sharded', shards: extra || undefined };
  }
  if (peek.size < minBytes) return { name, sharded: false, skipped: 'small' };

  console.log(`Sharding ${name} (${Math.round(peek.size / 1024 / 1024)}MB)…`);
  if (peek.size <= MEMORY_MAX_BYTES) {
    const cache = parsePackageCache(JSON.parse(await readFile(filePath, 'utf8')), peek.package);
    const result = await shardInMemory(filePath, cache);
    if (!result) return { name, sharded: false, skipped: 'no-nested-modules' };
    const extra = await refineLargeShards(filePath);
    console.log(`  ${name}: root ${result.rootEntries} entries, ${result.shards} shards`);
    return { name, sharded: true, shards: result.shards + extra, rootEntries: result.rootEntries };
  }

  const meta = {
    package: peek.package || name,
    sourceUrl: peek.sourceUrl || '',
    generatedAt: peek.generatedAt || new Date().toISOString(),
  };
  const result = await shardStreaming(filePath, meta);
  if (result.shards === 0) {
    console.log(`  ${name}: no nested modules; leaving single-file`);
    return { name, sharded: false, skipped: 'no-nested-modules' };
  }
  const extra = await refineLargeShards(filePath);
  console.log(`  ${name}: root ${result.rootEntries} entries, ${result.shards} shards`);
  return { name, sharded: true, shards: result.shards + extra, rootEntries: result.rootEntries };
}

function basenameNoExt(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.json') ? base.slice(0, -5) : base;
}

async function updateIndex(results: Array<{ name: string; sharded: boolean }>): Promise<void> {
  const indexPath = join(cacheDir, 'index.json');
  let index: CacheIndex = { packages: [] };
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8')) as CacheIndex;
    if (!Array.isArray(index.packages)) index = { packages: [] };
  } catch {
    index = { packages: [] };
  }
  const byName = new Map(results.map((r) => [r.name, r]));
  for (const entry of index.packages) {
    const filePath = join(cacheDir, entry.file);
    try {
      const peek = await peekFile(filePath);
      if (peek.generatedAt) entry.generatedAt = peek.generatedAt;
      const sharded = peek.sharded || byName.get(entry.name)?.sharded === true;
      if (sharded) entry.sharded = true;
      else delete entry.sharded;
    } catch {
      // Keep the existing index row if the file is missing.
    }
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export async function runShardCache(minBytes = DEFAULT_MIN_BYTES): Promise<void> {
  const names = process.argv.filter((a) => a.endsWith('.json') && !a.startsWith('--'));
  const files = names.length
    ? names.map((n) => (n.includes('/') ? n : join(cacheDir, n)))
    : (await readdir(cacheDir))
      .filter((n) => n.endsWith('.json') && !SKIP_FILES.has(n))
      .map((n) => join(cacheDir, n));

  const results: Array<{ name: string; sharded: boolean }> = [];
  for (const file of files) {
    const result = await shardCacheFile(file, minBytes);
    results.push(result);
  }
  await updateIndex(results);
  const sharded = results.filter((r) => r.sharded && r.skipped !== 'already-sharded');
  console.log(`Done. Newly sharded: ${sharded.length}. Index updated.`);
}

const isMain = (() => {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return fileURLToPath(import.meta.url) === join(argvPath) || fileURLToPath(import.meta.url).endsWith(argvPath);
  } catch {
    return false;
  }
})();

if (isMain) {
  runShardCache(minBytesFromArgv()).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
