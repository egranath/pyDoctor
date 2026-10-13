import type { CacheEntry, PackageCache, ShardManifestEntry } from '../types';
import { lastSegment, parentPath } from './paths';
import { sortEntries } from './schema';

export const ROOT_SHARD = '__root__';
export const FULL_SHARD = '__full__';
/** Keep each stored section around this size so IndexedDB can clone it. */
export const MAX_SHARD_BYTES = 32 * 1024 * 1024;

export function shardRecordId(packageName: string, shard: string, version: string): string {
  return `${packageName}\t${shard}\t${version}`;
}

export function shardFileName(packageName: string, shardId: string): string {
  const parts = shardId.split('.').map((s) => s.replace(/[^A-Za-z0-9._-]+/g, '_') || '_');
  return `${packageName}/${parts.join('/')}.json`;
}

/**
 * Shard key at a given parent. `parentShard` null splits the package root (`pkg.X.*` → `X`);
 * `parentShard` `vector` splits that module (`pkg.vector.Y.*` → `vector.Y`).
 */
export function shardIdAtLevel(packageName: string, path: string, parentShard: string | null): string | null {
  const base = parentShard ? `${packageName}.${parentShard}` : packageName;
  if (path === base) return null;
  const prefix = `${base}.`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot === -1) return null;
  const next = rest.slice(0, dot);
  return parentShard ? `${parentShard}.${next}` : next;
}

/** Nested `pkg.X.*` → `X`. Top-level members and the package root → null (live in the root file). */
export function nestedShardId(packageName: string, path: string): string | null {
  return shardIdAtLevel(packageName, path, null);
}

export function memberIdAtLevel(packageName: string, path: string, parentShard: string | null): string | null {
  const base = parentShard ? `${packageName}.${parentShard}` : packageName;
  const prefix = `${base}.`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || rest.includes('.')) return null;
  return parentShard ? `${parentShard}.${rest}` : rest;
}

export function topLevelMemberId(packageName: string, path: string): string | null {
  return memberIdAtLevel(packageName, path, null);
}

/** Deepest manifest key that is a dotted prefix of the path after the package name. */
export function shardIdForPath(
  packageName: string,
  path: string,
  manifest: Record<string, ShardManifestEntry> | undefined,
): string | null {
  if (!manifest) return null;
  if (path === packageName) return null;
  const prefix = `${packageName}.`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const parts = rest.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const id = parts.slice(0, i).join('.');
    if (manifest[id]) return id;
  }
  return null;
}

export function shardIdsForPath(
  packageName: string,
  path: string,
  manifest: Record<string, ShardManifestEntry> | undefined,
): string[] {
  const ids: string[] = [];
  const main = shardIdForPath(packageName, path, manifest);
  if (main) ids.push(main);
  const inner = sameNameModulePath(path);
  if (inner) {
    const innerId = shardIdForPath(packageName, inner, manifest);
    if (innerId && !ids.includes(innerId)) ids.push(innerId);
  }
  return ids;
}

export function hasShardManifest(cache: PackageCache): boolean {
  return Boolean(cache.shards && Object.keys(cache.shards).length > 0);
}

/**
 * `pkg.mod` implemented as `pkg/mod/mod.py` shows up in inventories as
 * `pkg.mod.mod.*`. The package page should list those members.
 */
export function sameNameModulePath(path: string): string | null {
  const leaf = lastSegment(path);
  if (!leaf || !path.includes('.')) return null;
  return `${path}.${leaf}`;
}

export function sameNameModuleMembers(indexed: IndexedPackage, path: string): CacheEntry[] {
  const innerPath = sameNameModulePath(path);
  if (!innerPath) return [];
  const inner = indexed.byPath.get(innerPath);
  if (!inner || (inner.kind !== 'module' && inner.kind !== 'package')) return [];
  return indexed.children.get(innerPath) ?? [];
}

export interface IndexedPackage {
  cache: PackageCache;
  byPath: Map<string, CacheEntry>;
  children: Map<string, CacheEntry[]>;
  bundled: boolean;
  loadedShards: Set<string>;
}

export interface StoredShard {
  id: string;
  package: string;
  shard: string;
  version: string;
  bundled: boolean;
  sourceUrl: string;
  generatedAt: string;
  entries: CacheEntry[];
  byPath: Array<[string, CacheEntry]>;
  children: Array<[string, string[]]>;
  shards?: Record<string, ShardManifestEntry>;
}

function makeSyntheticNamespace(path: string): CacheEntry {
  return {
    path,
    kind: 'module',
    dispname: lastSegment(path),
    docUri: null,
    signature: null,
    doc: '',
    doc_summary: '',
  };
}

/**
 * Index inventory rows and fill Sphinx prefix holes.
 * Search already sees every entry; pages only listed *direct* inventory children,
 * so missing nodes like `sympy.solvers.diophantine` 404'd. Every dotted prefix of
 * every entry becomes a namespace whose members are the next unique segment
 * (module/package) plus any real direct children. `cache.entries` is left
 * unchanged so search scoring stays the same.
 */
export function indexCache(cache: PackageCache, bundled: boolean, shardId: string): IndexedPackage {
  const byPath = new Map<string, CacheEntry>();
  const children = new Map<string, CacheEntry[]>();
  const childSeen = new Map<string, Set<string>>();
  const realPaths = new Set<string>();

  const addChild = (parent: string, child: CacheEntry): void => {
    let seen = childSeen.get(parent);
    if (!seen) {
      seen = new Set();
      childSeen.set(parent, seen);
    }
    if (seen.has(child.path)) return;
    seen.add(child.path);
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  };

  for (const entry of cache.entries) {
    byPath.set(entry.path, entry);
    realPaths.add(entry.path);
    const parts = entry.path.split('.');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('.');
      if (!byPath.has(prefix)) byPath.set(prefix, makeSyntheticNamespace(prefix));
    }
  }

  for (const entry of byPath.values()) {
    addChild(parentPath(entry.path) ?? '', entry);
  }

  const syntheticPaths = [...byPath.keys()].filter((path) => !realPaths.has(path));
  syntheticPaths.sort((a, b) => b.length - a.length);
  for (const path of syntheticPaths) {
    const node = byPath.get(path);
    if (!node) continue;
    const kids = children.get(path) ?? [];
    const hasNs = kids.some((c) => c.kind === 'module' || c.kind === 'package');
    node.kind = hasNs ? 'package' : 'module';
  }

  for (const list of children.values()) {
    list.sort(sortEntries);
  }
  return { cache, byPath, children, bundled, loadedShards: new Set([shardId]) };
}

function rebuildChildren(byPath: Map<string, CacheEntry>): Map<string, CacheEntry[]> {
  const children = new Map<string, CacheEntry[]>();
  const childSeen = new Map<string, Set<string>>();
  for (const entry of byPath.values()) {
    const parent = parentPath(entry.path) ?? '';
    let seen = childSeen.get(parent);
    if (!seen) {
      seen = new Set();
      childSeen.set(parent, seen);
    }
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort(sortEntries);
  }
  return children;
}

export function mergeIndexed(base: IndexedPackage, extra: IndexedPackage): IndexedPackage {
  const extraReal = new Set(extra.cache.entries.map((e) => e.path));
  const byPath = new Map(base.byPath);
  for (const [path, entry] of extra.byPath) {
    const current = byPath.get(path);
    if (!current || extraReal.has(path)) byPath.set(path, entry);
  }

  const entries = [...base.cache.entries];
  const seen = new Set(entries.map((e) => e.path));
  for (const entry of extra.cache.entries) {
    if (!seen.has(entry.path)) {
      entries.push(entry);
      seen.add(entry.path);
    } else {
      const i = entries.findIndex((e) => e.path === entry.path);
      if (i >= 0) entries[i] = entry;
    }
  }

  const shards = base.cache.shards ?? extra.cache.shards;
  const cache: PackageCache = {
    package: base.cache.package,
    sourceUrl: base.cache.sourceUrl || extra.cache.sourceUrl,
    generatedAt: base.cache.generatedAt || extra.cache.generatedAt,
    entries,
  };
  if (shards) cache.shards = shards;

  const loadedShards = new Set(base.loadedShards);
  for (const id of extra.loadedShards) loadedShards.add(id);

  return {
    cache,
    byPath,
    children: rebuildChildren(byPath),
    bundled: base.bundled || extra.bundled,
    loadedShards,
  };
}

export function toStoredShard(indexed: IndexedPackage, shard: string, version: string): StoredShard {
  const row: StoredShard = {
    id: shardRecordId(indexed.cache.package, shard, version),
    package: indexed.cache.package,
    shard,
    version,
    bundled: indexed.bundled,
    sourceUrl: indexed.cache.sourceUrl,
    generatedAt: indexed.cache.generatedAt,
    entries: indexed.cache.entries,
    byPath: [...indexed.byPath.entries()],
    children: [...indexed.children.entries()].map(([parent, kids]) => [parent, kids.map((e) => e.path)]),
  };
  if (indexed.cache.shards) row.shards = indexed.cache.shards;
  return row;
}

export function fromStoredShard(row: StoredShard): IndexedPackage {
  const byPath = new Map(row.byPath);
  const children = new Map<string, CacheEntry[]>();
  for (const [parent, paths] of row.children) {
    const list: CacheEntry[] = [];
    for (const path of paths) {
      const entry = byPath.get(path);
      if (entry) list.push(entry);
    }
    children.set(parent, list);
  }
  const cache: PackageCache = {
    package: row.package,
    sourceUrl: row.sourceUrl,
    generatedAt: row.generatedAt,
    entries: row.entries,
  };
  if (row.shards) cache.shards = row.shards;
  return {
    cache,
    byPath,
    children,
    bundled: row.bundled,
    loadedShards: new Set([row.shard]),
  };
}

export interface SplitPackageResult {
  root: PackageCache;
  shards: Map<string, PackageCache>;
}

export function splitPackageCache(cache: PackageCache, parentShard: string | null = null): SplitPackageResult | null {
  if (!parentShard && hasShardManifest(cache)) return null;
  const pkg = cache.package;
  const rootEntries: CacheEntry[] = [];
  const topLevel = new Map<string, CacheEntry>();
  const nested = new Map<string, CacheEntry[]>();

  for (const entry of cache.entries) {
    const shard = shardIdAtLevel(pkg, entry.path, parentShard);
    if (shard === null) {
      rootEntries.push(entry);
      const id = memberIdAtLevel(pkg, entry.path, parentShard);
      if (id) topLevel.set(id, entry);
    } else {
      const list = nested.get(shard) ?? [];
      list.push(entry);
      nested.set(shard, list);
    }
  }

  if (nested.size === 0) return null;

  const manifest: Record<string, ShardManifestEntry> = {};
  const shards = new Map<string, PackageCache>();
  for (const [id, entries] of nested) {
    const head = topLevel.get(id);
    const shardEntries = head ? [head, ...entries] : entries;
    const file = shardFileName(pkg, id);
    manifest[id] = { file, count: shardEntries.length };
    shards.set(id, {
      package: pkg,
      sourceUrl: cache.sourceUrl,
      generatedAt: cache.generatedAt,
      entries: shardEntries,
    });
  }

  const root: PackageCache = {
    package: cache.package,
    sourceUrl: cache.sourceUrl,
    generatedAt: cache.generatedAt,
    entries: rootEntries,
  };
  if (!parentShard) {
    return {
      root: {
        package: cache.package,
        sourceUrl: cache.sourceUrl,
        generatedAt: cache.generatedAt,
        shards: manifest,
        entries: rootEntries,
        ...(cache.uploadBytes !== undefined ? { uploadBytes: cache.uploadBytes } : {}),
      },
      shards,
    };
  }
  return { root, shards };
}

/** Rough JSON size, enough to decide when a section needs another split. */
export function estimateCacheBytes(cache: PackageCache): number {
  let n = 128;
  for (const entry of cache.entries) {
    n += 96;
    n += entry.path.length;
    n += entry.dispname.length;
    n += entry.doc?.length ?? 0;
    n += entry.doc_summary?.length ?? 0;
    n += entry.signature?.length ?? 0;
    n += entry.docUri?.length ?? 0;
    n += entry.aliasOf?.length ?? 0;
    if (entry.searchTerms) {
      for (const term of entry.searchTerms) n += term.length + 4;
    }
  }
  return n;
}

export function cacheExceedsShardLimit(cache: PackageCache, maxBytes = MAX_SHARD_BYTES): boolean {
  return estimateCacheBytes(cache) > maxBytes;
}

/**
 * Split a large flat cache into a small root plus module shards.
 * Shards over `maxBytes` are split again. Returns null when the cache
 * already has a manifest or is small enough to store whole.
 */
export function partitionLargeCache(cache: PackageCache, maxBytes = MAX_SHARD_BYTES): SplitPackageResult | null {
  if (hasShardManifest(cache) || !cacheExceedsShardLimit(cache, maxBytes)) return null;
  const split = splitPackageCache(cache);
  if (!split?.root.shards) return null;
  const manifest = split.root.shards;
  const queue = [...split.shards.keys()];
  while (queue.length) {
    const id = queue.pop()!;
    const shard = split.shards.get(id);
    if (!shard || !cacheExceedsShardLimit(shard, maxBytes)) continue;
    const sub = splitPackageCache(shard, id);
    if (!sub) continue;
    split.shards.set(id, sub.root);
    const info = manifest[id];
    if (info) info.count = sub.root.entries.length;
    for (const [subId, subShard] of sub.shards) {
      split.shards.set(subId, subShard);
      manifest[subId] = {
        file: shardFileName(cache.package, subId),
        count: subShard.entries.length,
      };
      queue.push(subId);
    }
  }
  return split;
}
