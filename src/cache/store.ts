import type {
  CacheIndex,
  CacheIndexEntry,
  CatalogTopEntry,
  Kind,
  Member,
  ObjectDescription,
  PackageCache,
  PypiIndexEntry,
  PypiInfo,
  SearchSuggestion,
} from '../types';
import { isPrivateSegment, lastSegment, parentPath } from './paths';
import {
  fetchAsCache,
  loadBundledCaches,
  loadBundledIndex,
  loadBundledPackage,
  loadBundledShardFile,
  loadCatalogTop,
  loadPypiIndex,
} from './loader';
import { sortEntries } from './schema';
import { isEmptyApiCache } from './inventory';
import { pep503Normalize } from './packageAliases';
import { PYPI_SUGGESTION_LIMIT, pypiInfoFromIndex } from './pypi';
import {
  idbDeletePackage,
  idbDeleteUploadShards,
  idbGetPackage,
  idbGetShard,
  idbListPackages,
  idbPutPackage,
  idbPutPackageStrict,
  idbPutShard,
  idbPutShardStrict,
} from './idb';
import { cacheByteLength, isUserUploadedCache } from './ingestFile';
import {
  FULL_SHARD,
  ROOT_SHARD,
  type IndexedPackage,
  cacheExceedsShardLimit,
  fromStoredShard,
  hasShardManifest,
  indexCache,
  mergeIndexed,
  partitionLargeCache,
  sameNameModuleMembers,
  shardIdForPath,
  shardIdsForPath,
  toStoredShard,
} from './shards';

export type { IndexedPackage } from './shards';

const LOADED_KEY = 'db_loaded_packages';
const LISTED_KEY = 'db_listed_packages';

function writeLoadedNames(names: string[]): void {
  try {
    localStorage.setItem(LOADED_KEY, JSON.stringify(names));
  } catch {
    // ignore quota / private mode
  }
}

function readListedNames(): string[] | null {
  try {
    const raw = localStorage.getItem(LISTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

function writeListedNames(names: string[]): void {
  try {
    localStorage.setItem(LISTED_KEY, JSON.stringify(names));
  } catch {
    // ignore quota / private mode
  }
}

function isDefaultListed(entry: CacheIndexEntry): boolean {
  return entry.pinned === true || entry.loadByDefault === true;
}

function stdlibNameSet(index: CacheIndex): Set<string> {
  return new Set(
    index.packages.filter((p) => p.file === 'stdlib.json').map((p) => p.name),
  );
}

/** Old builds listed every stdlib module (~180). Treat that saved set as stale. */
function looksLikeLegacyStdlibListing(saved: string[], stdlib: Set<string>): boolean {
  if (stdlib.size === 0) return false;
  let n = 0;
  for (const name of saved) {
    if (stdlib.has(name)) n += 1;
  }
  return n >= Math.max(40, Math.ceil(stdlib.size * 0.75));
}

function withoutBulkStdlib(names: string[], stdlib: Set<string>): string[] {
  return names.filter((name) => !stdlib.has(name));
}

function entryToMember(entry: CacheEntryLike, packageName: string): Member {
  const leaf = lastSegment(entry.path);
  const name = entry.dispname || leaf;
  return {
    name,
    kind: entry.kind,
    path: entry.path,
    signature: entry.signature ?? null,
    doc_summary: entry.doc_summary ?? '',
    value_preview: null,
    is_private: packageName !== 'syntax' && isPrivateSegment(leaf),
    docUri: entry.docUri,
    searchTerms: entry.searchTerms,
  };
}

type CacheEntryLike = IndexedPackage['byPath'] extends Map<string, infer V> ? V : never;

function resolveAliasEntry(
  entry: CacheEntryLike | undefined,
  byPath: IndexedPackage['byPath'],
): CacheEntryLike | undefined {
  if (!entry?.aliasOf || entry.aliasOf === entry.path) return entry;
  const src = byPath.get(entry.aliasOf);
  if (!src) return entry;
  return {
    ...src,
    path: entry.path,
    kind: entry.kind,
    dispname: entry.dispname,
    aliasOf: entry.aliasOf,
  };
}

function appendMembers(local: CacheEntryLike[], extra: CacheEntryLike[]): CacheEntryLike[] {
  if (extra.length === 0) return local;
  const seen = new Set(local.map((entry) => entry.path));
  const out = [...local];
  for (const entry of extra) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  out.sort(sortEntries);
  return out;
}

function mergeChildEntries(local: CacheEntryLike[], aliased: CacheEntryLike[]): CacheEntryLike[] {
  if (aliased.length === 0) return local;
  const seen = new Set(local.map((e) => lastSegment(e.path)));
  const out = [...local];
  for (const entry of aliased) {
    const name = lastSegment(entry.path);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
  }
  out.sort(sortEntries);
  return out;
}

function describeFromIndexed(indexed: IndexedPackage, path: string): ObjectDescription | null {
  const raw = indexed.byPath.get(path);
  const entry = resolveAliasEntry(raw, indexed.byPath);
  const localChildren = indexed.children.get(path) ?? [];
  const aliasOf = raw?.aliasOf && raw.aliasOf !== path ? raw.aliasOf : undefined;
  const aliasChildren = aliasOf ? (indexed.children.get(aliasOf) ?? []) : [];
  const childEntries = mergeChildEntries(localChildren, aliasChildren);
  // Valid if this is an inventory row, a synthesized prefix, or has children.
  if (!entry && childEntries.length === 0) return null;

  const isSyntaxRoot = indexed.cache.package === 'syntax' && path === 'syntax';
  const memberEntries = isSyntaxRoot
    ? childEntries.flatMap((cat) => indexed.children.get(cat.path) ?? [])
    : appendMembers(childEntries, sameNameModuleMembers(indexed, path));
  const members = memberEntries.map((child) => (
    entryToMember(resolveAliasEntry(child, indexed.byPath) ?? child, indexed.cache.package)
  ));
  const name = lastSegment(path);
  const parent = parentPath(path) ?? '';
  let kind: Kind = entry?.kind ?? 'module';
  if (!entry) {
    const hasNs = childEntries.some((c) => c.kind === 'module' || c.kind === 'package');
    kind = hasNs ? 'package' : 'module';
  }

  return {
    package: indexed.cache.package,
    kind,
    name,
    qualname: name,
    module: parent,
    path,
    dispname: entry?.dispname || name,
    signature: entry?.signature ?? null,
    doc: entry?.doc ?? '',
    doc_summary: entry?.doc_summary ?? '',
    docUri: entry?.docUri ?? null,
    members,
    member_count: members.length,
    is_truncated: false,
    aliases: aliasOf ? [aliasOf] : [],
  };
}

function norm(s: string): string {
  return s.replace(/_/g, '').replace(/\s/g, '').toLowerCase();
}

function catalogNameMatches(entry: CacheIndexEntry, tokens: string[]): boolean {
  const names = [entry.name, ...(entry.aliases ?? [])];
  return names.some((name) => {
    const hay = norm(name);
    return tokens.every((t) => hay.includes(t));
  });
}

type SearchableEntry = {
  path: string;
  kind: Kind;
  dispname?: string;
  doc_summary?: string;
  signature?: string | null;
  searchTerms?: string[];
};

function fieldHay(entry: SearchableEntry): string {
  return norm([lastSegment(entry.path), entry.dispname ?? '', ...(entry.searchTerms ?? [])].join(' '));
}

function entryMatches(entry: SearchableEntry, tokens: string[], raw: string): boolean {
  const fields = fieldHay(entry);
  if (tokens.every((t) => fields.includes(t))) return true;
  const allowPath = raw.includes('.') || tokens.some((t) => t.length >= 3);
  if (!allowPath) return false;
  return tokens.every((t) => norm(entry.path).includes(t));
}

function glyphExact(entry: SearchableEntry, query: string): boolean {
  const q = query.toLowerCase();
  if (lastSegment(entry.path).toLowerCase() === q) return true;
  if ((entry.dispname ?? '').toLowerCase() === q) return true;
  return (entry.searchTerms ?? []).some((term) => term.toLowerCase() === q);
}

function cacheVersion(entry: CacheIndexEntry | undefined, cache?: PackageCache): string {
  return cache?.generatedAt || entry?.generatedAt || '';
}

function isUploadSource(sourceUrl: string | undefined): boolean {
  const src = sourceUrl || '';
  return src.startsWith('walk:') || src.startsWith('upload:');
}

type Listener = () => void;

class PackageStore {
  private loaded = new Map<string, IndexedPackage>();
  private available = new Map<string, IndexedPackage>();
  private listed = new Set<string>();
  private bundledIndex: CacheIndex = { packages: [] };
  private listeners = new Set<Listener>();
  private ready: Promise<void> | null = null;
  private inflight = new Map<string, Promise<IndexedPackage>>();
  /** Raw stdlib slices for unloaded member search. Not indexed, not listed, not IDB. */
  private stdlibSearch: PackageCache[] | null = null;
  private catalogTop: CatalogTopEntry[] | null = null;
  private pypiIndex: PypiIndexEntry[] | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    writeLoadedNames([...this.loaded.keys()]);
    writeListedNames([...this.listed]);
    for (const listener of this.listeners) listener();
  }

  catalog(): CacheIndexEntry[] {
    return this.bundledIndex.packages;
  }

  bundledNames(): string[] {
    return this.bundledIndex.packages.map((p) => p.name);
  }

  loadedNames(): string[] {
    return [...this.loaded.keys()].sort((a, b) => a.localeCompare(b));
  }

  listedNames(): string[] {
    return [...this.listed].sort((a, b) => a.localeCompare(b));
  }

  /** True when listed + loaded already match a fresh-visit default sidebar. */
  isDefaultSidebar(): boolean {
    const defaults = this.defaultListedNames();
    const defaultSet = new Set(defaults);
    for (const name of this.listed) {
      if (defaultSet.has(name)) continue;
      if (!this.isManuallyAdded(name)) return false;
    }
    for (const name of defaults) {
      if (!this.listed.has(name) || !this.loaded.has(name)) return false;
    }
    for (const name of this.loaded.keys()) {
      if (defaultSet.has(name)) continue;
      if (!this.isManuallyAdded(name)) return false;
    }
    return true;
  }

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  isPending(name: string): boolean {
    if (this.inflight.has(name)) return true;
    const prefix = `${name}::`;
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  isPinned(name: string): boolean {
    return this.entryFor(name)?.pinned === true;
  }

  isCore(name: string): boolean {
    return name === 'builtins' || name === 'syntax';
  }

  isStdlib(name: string): boolean {
    if (this.isCore(name)) return false;
    return this.entryFor(name)?.file === 'stdlib.json';
  }

  /** JSON-uploaded packages, not names from the bundled catalog. */
  isManuallyAdded(name: string): boolean {
    if (this.entryFor(name)) return false;
    return this.listed.has(name);
  }

  private entryFor(name: string): CacheIndexEntry | undefined {
    return this.bundledIndex.packages.find((p) => p.name === name);
  }

  /** Path to open when the user clicks a loaded package in the sidebar. */
  rootPath(name: string): string {
    const indexed = this.loaded.get(name);
    if (!indexed) return name;
    if (indexed.byPath.has(name)) return name;
    for (const entry of indexed.cache.entries) {
      if (parentPath(entry.path) === null) return entry.path;
    }
    return name;
  }

  init(): Promise<void> {
    if (!this.ready) this.ready = this.doInit();
    return this.ready;
  }

  private defaultListedNames(): string[] {
    return this.bundledIndex.packages.filter(isDefaultListed).map((p) => p.name);
  }

  private async doInit(): Promise<void> {
    this.bundledIndex = await loadBundledIndex();
    const defaults = this.defaultListedNames();
    const stdlib = stdlibNameSet(this.bundledIndex);
    const savedListed = readListedNames();
    const listedLegacy = savedListed !== null && looksLikeLegacyStdlibListing(savedListed, stdlib);

    // Sidebar rows persist; JSON is fetched on demand. Restoring every previously
    // loaded package (sympy is ~900MB) is what made reloads take tens of seconds.
    if (listedLegacy && savedListed) {
      this.listed = new Set([...defaults, ...withoutBulkStdlib(savedListed, stdlib)]);
    } else {
      this.listed = new Set(savedListed ?? defaults);
    }
    for (const entry of this.bundledIndex.packages) {
      if (isDefaultListed(entry)) this.listed.add(entry.name);
    }
    for (const entry of this.bundledIndex.packages) {
      if (!isDefaultListed(entry)) continue;
      try {
        await this.loadExisting(entry.name, true);
      } catch {
        // Skip default names that can no longer be resolved.
      }
    }
    this.emit();
  }

  /**
   * Fetch unloaded APIs into `available` (radios stay off) so typeahead can
   * suggest members. Listed-unloaded always; catalog roots only on a 2+ char
   * prefix or `pkg.…` query. Does not emit — sidebar must not flicker on.
   */
  async preloadUnloadedForSearch(query: string, onProgress?: () => void): Promise<void> {
    await this.init();
    const q = query.trim();
    if (!q) return;

    const targets = this.unloadedSearchTargets(q);
    await Promise.all(targets.map(async (name) => {
      if (this.loaded.has(name) || this.available.has(name)) return;
      try {
        await this.loadExisting(name, false);
        onProgress?.();
      } catch {
        // Catalog name fallback still covers this package.
      }
    }));

    const match = this.longestCatalogPrefix(q);
    if (!match || q === match || !q.startsWith(`${match}.`)) return;
    if (this.loaded.has(match)) return;
    try {
      await this.ensureShardsForPath(match, q, false);
      onProgress?.();
    } catch {
      // Root-level suggestions are enough until the user opens a path.
    }
  }

  /**
   * Load stdlib.json + catalog-top for a second-wave member scan.
   * Does not emit, index, list, or persist shards.
   */
  async ensureUnloadedSearchExtras(query: string): Promise<void> {
    if (query.trim().length < 3) return;
    if (!this.stdlibSearch) {
      try {
        this.stdlibSearch = await loadBundledCaches('stdlib.json');
      } catch {
        this.stdlibSearch = [];
      }
    }
    if (!this.catalogTop) {
      try {
        const top = await loadCatalogTop();
        this.catalogTop = top?.entries ?? [];
      } catch {
        this.catalogTop = [];
      }
    }
  }

  async ensurePypiIndex(): Promise<void> {
    if (this.pypiIndex) return;
    try {
      const index = await loadPypiIndex();
      this.pypiIndex = index?.entries ?? [];
    } catch {
      this.pypiIndex = [];
    }
  }

  catalogHasName(name: string): boolean {
    const key = pep503Normalize(name);
    const lower = name.trim().toLowerCase();
    if (!key && !lower) return false;
    for (const entry of this.bundledIndex.packages) {
      if (pep503Normalize(entry.name) === key || entry.name.toLowerCase() === lower) return true;
      if ((entry.aliases ?? []).some((alias) => (
        pep503Normalize(alias) === key || alias.toLowerCase() === lower
      ))) return true;
    }
    return false;
  }

  isEmptyApi(name: string): boolean {
    const indexed = this.loaded.get(name);
    return indexed ? isEmptyApiCache(indexed.cache) : false;
  }

  searchPypi(query: string, limit = PYPI_SUGGESTION_LIMIT): PypiInfo[] {
    const q = query.trim();
    if (!q || !this.pypiIndex) return [];
    const tokens = q.split(/\s+/).map(norm).filter(Boolean);
    if (tokens.length === 0) return [];
    const qLower = q.toLowerCase();
    const qNorm = pep503Normalize(q);
    const hits: { info: PypiInfo; rank: number }[] = [];
    for (const entry of this.pypiIndex) {
      if (this.catalogHasName(entry.name)) continue;
      const hay = norm([entry.name, entry.summary ?? '', ...(entry.keywords ?? [])].join(' '));
      if (!tokens.every((t) => hay.includes(t))) continue;
      const nameLower = entry.name.toLowerCase();
      const exact = nameLower === qLower || pep503Normalize(entry.name) === qNorm ? 0 : 1;
      const prefix = nameLower.startsWith(qLower) || pep503Normalize(entry.name).startsWith(qNorm) ? 0 : 1;
      hits.push({ info: pypiInfoFromIndex(entry), rank: exact * 2 + prefix });
    }
    hits.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.info.name.localeCompare(b.info.name);
    });
    return hits.slice(0, limit).map((row) => row.info);
  }

  /** Listed-unloaded names, plus catalog packages whose name is a prefix of the query. */
  private unloadedSearchTargets(query: string): string[] {
    const names = new Set<string>();
    for (const name of this.listed) {
      if (!this.loaded.has(name)) names.add(name);
    }
    const qLower = query.toLowerCase();
    if (qLower.length >= 2) {
      for (const entry of this.bundledIndex.packages) {
        if (this.loaded.has(entry.name)) continue;
        const n = entry.name.toLowerCase();
        if (n.startsWith(qLower) || qLower.startsWith(`${n}.`)) names.add(entry.name);
      }
    }
    return [...names];
  }

  /** Longest bundled package name that equals `path` or is a dotted prefix of it. */
  private longestCatalogPrefix(path: string): string | undefined {
    let best: string | undefined;
    for (const entry of this.bundledIndex.packages) {
      const name = entry.name;
      if (path === name || path.startsWith(`${name}.`)) {
        if (!best || name.length > best.length) best = name;
      }
    }
    return best;
  }

  private placeIndexed(name: string, indexed: IndexedPackage, intoLoaded: boolean): IndexedPackage {
    const current = this.loaded.get(name) ?? this.available.get(name);
    const use = current ? mergeIndexed(current, indexed) : indexed;
    if (intoLoaded) {
      this.available.delete(name);
      this.loaded.set(name, use);
    } else if (!this.loaded.has(name)) {
      this.available.set(name, use);
    } else {
      this.loaded.set(name, use);
    }
    return use;
  }

  private replaceIndexed(name: string, indexed: IndexedPackage): IndexedPackage {
    if (this.loaded.has(name)) {
      this.available.delete(name);
      this.loaded.set(name, indexed);
      return indexed;
    }
    if (this.available.has(name)) {
      this.available.set(name, indexed);
      return indexed;
    }
    this.loaded.set(name, indexed);
    return indexed;
  }

  private async persistShard(indexed: IndexedPackage, shard: string, version: string): Promise<void> {
    if (!version) return;
    const slice = isolateShard(indexed, shard);
    await idbPutShard(toStoredShard(slice, shard, version));
  }

  private async loadFromIdb(name: string, shard: string, version: string): Promise<IndexedPackage | null> {
    if (!version) return null;
    const row = await idbGetShard(name, shard, version);
    if (!row) return null;
    return fromStoredShard(row);
  }

  private fetchIndexed(name: string): Promise<IndexedPackage> {
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const task = (async () => {
      const catalog = this.entryFor(name);
      const stored = await idbGetPackage(name);
      if (stored && isUploadSource(stored.sourceUrl)) {
        const shard = hasShardManifest(stored) ? ROOT_SHARD : FULL_SHARD;
        return indexCache(stored, false, shard);
      }
      const file = catalog?.file;
      const version = cacheVersion(catalog);
      if (file) {
        const preferRoot = catalog?.sharded === true;
        const idbShard = preferRoot ? ROOT_SHARD : FULL_SHARD;
        const fromIdb = await this.loadFromIdb(name, idbShard, version);
        if (fromIdb) return fromIdb;
        const cache = await loadBundledPackage(file, name);
        const sharded = hasShardManifest(cache);
        const shard = sharded ? ROOT_SHARD : FULL_SHARD;
        const indexed = indexCache(cache, true, shard);
        void this.persistShard(indexed, shard, cacheVersion(catalog, cache));
        return indexed;
      }
      if (stored) {
        const shard = hasShardManifest(stored) ? ROOT_SHARD : FULL_SHARD;
        return indexCache(stored, false, shard);
      }
      throw new Error(`Package ${name} is not in the bundled catalog. Ingest a JSON cache from walk_package.py.`);
    })().finally(() => {
      this.inflight.delete(name);
    });
    this.inflight.set(name, task);
    return task;
  }

  private async loadExisting(name: string, intoLoaded: boolean): Promise<IndexedPackage> {
    const existing = this.loaded.get(name) ?? this.available.get(name);
    if (existing) return this.placeIndexed(name, existing, intoLoaded);
    const indexed = await this.fetchIndexed(name);
    return this.placeIndexed(name, indexed, intoLoaded);
  }

  private async ensureShardsForPath(name: string, path: string, intoLoaded = true): Promise<IndexedPackage> {
    const indexed = this.loaded.get(name) ?? this.available.get(name) ?? await this.loadExisting(name, intoLoaded);
    if (indexed.loadedShards.has(FULL_SHARD)) return indexed;

    let current = indexed;
    for (const shard of shardIdsForPath(name, path, indexed.cache.shards)) {
      current = await this.ensureShard(name, shard);
    }

    const raw = current.byPath.get(path);
    const aliasOf = raw?.aliasOf && raw.aliasOf !== path ? raw.aliasOf : undefined;
    if (aliasOf) {
      const aliasShard = shardIdForPath(name, aliasOf, current.cache.shards);
      if (aliasShard) current = await this.ensureShard(name, aliasShard);
    }
    return current;
  }

  private async ensureShard(name: string, shardId: string): Promise<IndexedPackage> {
    const existing = this.loaded.get(name) ?? this.available.get(name);
    if (existing?.loadedShards.has(shardId) || existing?.loadedShards.has(FULL_SHARD)) {
      return existing;
    }
    const key = `${name}::${shardId}`;
    const pending = this.inflight.get(key);
    if (pending) {
      await pending;
      return this.loaded.get(name) ?? this.available.get(name) ?? pending;
    }
    const task = (async () => {
      const base = this.loaded.get(name) ?? this.available.get(name);
      if (!base) throw new Error(`Package ${name} is not loaded.`);
      if (base.loadedShards.has(shardId) || base.loadedShards.has(FULL_SHARD)) return base;
      const info = base.cache.shards?.[shardId];
      if (!info) return base;
      const version = cacheVersion(this.entryFor(name), base.cache);
      const fromIdb = await this.loadFromIdb(name, shardId, version);
      if (fromIdb) return this.replaceIndexed(name, mergeIndexed(base, fromIdb));
      if (!base.bundled) {
        throw new Error(`Saved data for ${name} is missing the ${shardId} section. Ingest the package again.`);
      }
      const piece = indexCache(await loadBundledShardFile(info.file), true, shardId);
      void this.persistShard(piece, shardId, version);
      return this.replaceIndexed(name, mergeIndexed(base, piece));
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  async add(name: string, url?: string): Promise<IndexedPackage> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Package name is required.');
    if (this.loaded.has(trimmed) && !url) {
      this.listed.add(trimmed);
      this.emit();
      return this.loaded.get(trimmed)!;
    }

    const wasListed = this.listed.has(trimmed);
    this.listed.add(trimmed);

    try {
      if (url?.trim()) {
        this.emit();
        const cache = await fetchAsCache(trimmed, url.trim());
        cache.package = trimmed;
        await idbPutPackage(cache);
        const indexed = indexCache(cache, false, FULL_SHARD);
        this.available.delete(trimmed);
        this.loaded.set(trimmed, indexed);
        this.emit();
        return indexed;
      }

      const pending = this.loadExisting(trimmed, true);
      this.emit();
      const indexed = await pending;
      this.emit();
      return indexed;
    } catch (err) {
      if (!wasListed) this.listed.delete(trimmed);
      this.emit();
      throw err;
    }
  }

  async addCache(cache: PackageCache, onProgress?: (message: string) => void): Promise<IndexedPackage> {
    const trimmed = cache.package.trim();
    if (!trimmed) throw new Error('Cache file is missing a package name.');
    cache.package = trimmed;
    const wasListed = this.listed.has(trimmed);
    this.listed.add(trimmed);
    let writingShards = false;
    try {
      const split = !hasShardManifest(cache) ? partitionLargeCache(cache) : null;
      if (!split && !hasShardManifest(cache) && cacheExceedsShardLimit(cache)) {
        throw new Error('This package has no nested modules to split, and it is too large to store in the browser.');
      }
      let root = cache;
      if (split) {
        root = split.root;
        root.package = trimmed;
        cache.entries = [];
        writingShards = true;
        onProgress?.('Saving…');
        await idbDeleteUploadShards(trimmed);
        let done = 0;
        const total = split.shards.size;
        for (const [id, shard] of [...split.shards]) {
          done += 1;
          onProgress?.(`Saving ${done}/${total}…`);
          const indexedShard = indexCache(shard, false, id);
          await idbPutShardStrict(toStoredShard(indexedShard, id, root.generatedAt));
          split.shards.delete(id);
        }
        await idbPutPackageStrict(root);
      } else {
        await idbDeleteUploadShards(trimmed);
        await idbPutPackage(root);
      }
      const indexed = indexCache(root, false, hasShardManifest(root) ? ROOT_SHARD : FULL_SHARD);
      this.available.delete(trimmed);
      this.loaded.set(trimmed, indexed);
      this.emit();
      return indexed;
    } catch (err) {
      if (writingShards) {
        await idbDeleteUploadShards(trimmed);
        await idbDeletePackage(trimmed);
      }
      if (!wasListed) this.listed.delete(trimmed);
      this.emit();
      throw err;
    }
  }

  private catalogNameSet(): Set<string> {
    return new Set(this.bundledIndex.packages.map((p) => p.name));
  }

  async uploadedCacheStats(): Promise<{ names: string[]; bytes: number }> {
    const catalog = this.catalogNameSet();
    const rows = await idbListPackages();
    let bytes = 0;
    const names: string[] = [];
    for (const cache of rows) {
      if (!isUserUploadedCache(cache, catalog)) continue;
      names.push(cache.package);
      bytes += cache.uploadBytes ?? cacheByteLength(cache);
    }
    names.sort((a, b) => a.localeCompare(b));
    return { names, bytes };
  }

  async clearUploadedPackages(): Promise<void> {
    const catalog = this.catalogNameSet();
    const rows = await idbListPackages();
    for (const cache of rows) {
      if (!isUserUploadedCache(cache, catalog)) continue;
      const name = cache.package;
      await idbDeletePackage(name);
      await idbDeleteUploadShards(name);
      this.dropLoaded(name);
      if (catalog.has(name)) {
        if (this.listed.has(name)) {
          try {
            await this.loadExisting(name, true);
          } catch {
            const entry = this.entryFor(name);
            if (!this.isPinned(name) && !(entry && isDefaultListed(entry))) {
              this.listed.delete(name);
            }
          }
        }
      } else if (!this.isPinned(name)) {
        this.listed.delete(name);
      }
    }
    this.emit();
  }

  /** Unload from the working set but keep the sidebar row. */
  remove(name: string): void {
    this.unload(name);
  }

  unload(name: string): void {
    if (this.isPinned(name)) return;
    this.dropLoaded(name);
    this.emit();
  }

  /** Remove from the sidebar and unload. */
  unlist(name: string): void {
    if (this.isPinned(name) || this.isCore(name)) return;
    this.dropLoaded(name);
    this.listed.delete(name);
    this.emit();
  }

  async setLoaded(name: string, loaded: boolean): Promise<void> {
    if (loaded) {
      await this.add(name);
      return;
    }
    this.unload(name);
  }

  /**
   * Restore the fresh-visit sidebar: core builtins/syntax plus default-on packages.
   * Extra catalog listings are dropped; JSON-uploaded packages stay listed.
   */
  async resetToDefaults(): Promise<void> {
    const keep = new Set(this.defaultListedNames());
    for (const name of this.listed) {
      if (this.isManuallyAdded(name)) keep.add(name);
    }
    for (const name of [...this.loaded.keys()]) {
      if (!keep.has(name)) this.dropLoaded(name);
    }
    this.listed = new Set(keep);
    for (const name of keep) {
      if (this.loaded.has(name)) continue;
      try {
        await this.loadExisting(name, true);
      } catch {
        // Skip names that can no longer be resolved.
      }
    }
    this.emit();
  }

  resetListed(): Promise<void> {
    return this.resetToDefaults();
  }

  private dropLoaded(name: string): void {
    if (this.isPinned(name)) return;
    const indexed = this.loaded.get(name);
    if (!indexed) return;
    this.loaded.delete(name);
    if (indexed.bundled) this.available.set(name, indexed);
  }

  async ensureLoadedForPath(path: string): Promise<void> {
    await this.init();
    const match = this.longestCatalogPrefix(path);
    if (match) {
      const current = this.loaded.get(match);
      const needed = current ? shardIdsForPath(match, path, current.cache.shards) : [];
      const shardReady = !current
        || current.loadedShards.has(FULL_SHARD)
        || needed.every((id) => current.loadedShards.has(id));
      if (current && shardReady && this.describe(path)) return;
      await this.add(match);
      await this.ensureShardsForPath(match, path);
      return;
    }
    if (this.describe(path)) return;
    const builtinPath = path.includes('.') ? null : `builtins.${path}`;
    if (builtinPath && this.describe(builtinPath)) return;
    const listed = [...this.listed].sort((a, b) => b.length - a.length);
    for (const name of listed) {
      if (path !== name && !path.startsWith(`${name}.`)) continue;
      try {
        await this.add(name);
        await this.ensureShardsForPath(name, path);
        return;
      } catch {
        // Try the next listed name (stale IDB rows, etc.).
      }
    }
    if (builtinPath) {
      try {
        await this.add('builtins');
      } catch {
        // Builtins may be missing from a broken cache.
      }
    }
  }

  packageForPath(path: string): string | undefined {
    for (const [name, indexed] of this.loaded) {
      if (indexed.byPath.has(path) || indexed.children.has(path)) return name;
    }
    const builtinPath = path.includes('.') ? null : `builtins.${path}`;
    if (builtinPath) {
      const builtins = this.loaded.get('builtins');
      if (builtins && (builtins.byPath.has(builtinPath) || builtins.children.has(builtinPath))) {
        return 'builtins';
      }
    }
    const root = path.split('.')[0];
    if (root && this.loaded.has(root)) return root;
    for (const name of this.loaded.keys()) {
      if (path === name || path.startsWith(`${name}.`)) return name;
    }
    return undefined;
  }

  describe(path: string): ObjectDescription | null {
    const directPkg = this.packageForPath(path);
    if (directPkg) {
      const indexed = this.loaded.get(directPkg);
      if (indexed) {
        const found = describeFromIndexed(indexed, path);
        if (found) return found;
        if (!path.includes('.')) {
          const builtin = describeFromIndexed(indexed, `builtins.${path}`);
          if (builtin) return builtin;
        }
      }
    }
    const builtins = this.loaded.get('builtins');
    if (builtins && !path.includes('.')) {
      return describeFromIndexed(builtins, `builtins.${path}`);
    }
    return null;
  }

  /** Exact path, then exact glyph / search-term hit (prefers syntax punctuation, then operators). */
  resolveQuery(query: string): string | null {
    const q = query.trim();
    if (!q) return null;
    if (this.describe(q)) return q;
    const hits: { path: string }[] = [];
    const seen = new Set<string>();
    const scan = (entries: SearchableEntry[]): void => {
      for (const entry of entries) {
        if (seen.has(entry.path) || !glyphExact(entry, q)) continue;
        seen.add(entry.path);
        hits.push({ path: entry.path });
      }
    };
    for (const indexed of this.loaded.values()) scan(indexed.cache.entries);
    if (hits.length === 0) return null;
    const qLower = q.toLowerCase();
    hits.sort((a, b) => {
      const aLast = lastSegment(a.path).toLowerCase() === qLower ? 0 : 1;
      const bLast = lastSegment(b.path).toLowerCase() === qLower ? 0 : 1;
      if (aLast !== bLast) return aLast - bLast;
      const rank = (path: string): number => {
        if (path.startsWith('syntax.punctuation.')) return 0;
        if (path.startsWith('syntax.operators.')) return 1;
        if (path.startsWith('syntax.')) return 2;
        return 3;
      };
      const ar = rank(a.path);
      const br = rank(b.path);
      if (ar !== br) return ar - br;
      return a.path.localeCompare(b.path);
    });
    return hits[0]?.path ?? null;
  }

  search(query: string, limit = 20, includeUnloaded = false): SearchSuggestion[] {
    const q = query.trim();
    if (!q) return [];
    const tokens = q.split(/\s+/).map(norm).filter(Boolean);
    if (tokens.length === 0) return [];
    const qLower = q.toLowerCase();
    const results: SearchSuggestion[] = [];
    const seen = new Set<string>();
    const exactGlyph = new Set<string>();

    const push = (row: SearchSuggestion, exact = false): void => {
      if (seen.has(row.path)) return;
      seen.add(row.path);
      if (exact) exactGlyph.add(row.path);
      results.push(row);
    };

    const scanEntries = (
      packageName: string,
      entries: SearchableEntry[],
      unloaded: boolean,
    ): void => {
      for (const entry of entries) {
        if (seen.has(entry.path)) continue;
        if (!entryMatches(entry, tokens, q)) continue;
        push({
          path: entry.path,
          kind: entry.kind,
          doc_summary: entry.doc_summary ?? '',
          signature: entry.signature ?? null,
          package: packageName,
          unloaded: unloaded || undefined,
          manual: this.isManuallyAdded(packageName) || undefined,
        }, glyphExact(entry, q));
      }
    };

    const pushPackageName = (name: string, unloaded: boolean): void => {
      const entry = this.entryFor(name);
      if (entry) {
        if (!catalogNameMatches(entry, tokens)) return;
      } else if (!tokens.every((t) => norm(name).includes(t))) {
        return;
      }
      push({
        path: name,
        kind: 'package',
        doc_summary: '',
        signature: null,
        package: name,
        unloaded: unloaded || undefined,
        manual: this.isManuallyAdded(name) || undefined,
      });
    };

    for (const indexed of this.loaded.values()) scanEntries(indexed.cache.package, indexed.cache.entries, false);
    // Listed-unloaded packages are the sidebar working set, not gated on the toggle.
    for (const name of this.listed) {
      if (this.loaded.has(name)) continue;
      const indexed = this.available.get(name);
      if (indexed) scanEntries(indexed.cache.package, indexed.cache.entries, true);
      else pushPackageName(name, true);
    }
    if (includeUnloaded) {
      for (const [name, indexed] of this.available) {
        if (this.loaded.has(name) || this.listed.has(name)) continue;
        scanEntries(indexed.cache.package, indexed.cache.entries, true);
      }
      if (q.length >= 3 && this.stdlibSearch) {
        for (const cache of this.stdlibSearch) {
          if (this.loaded.has(cache.package) || this.available.has(cache.package)) continue;
          scanEntries(cache.package, cache.entries, true);
        }
      }
      if (q.length >= 3 && this.catalogTop) {
        for (const entry of this.catalogTop) {
          if (this.loaded.has(entry.package) || this.available.has(entry.package)) continue;
          scanEntries(entry.package, [entry], true);
        }
      }
      for (const entry of this.bundledIndex.packages) {
        if (this.loaded.has(entry.name) || seen.has(entry.name)) continue;
        if (!catalogNameMatches(entry, tokens)) continue;
        push({
          path: entry.name,
          kind: 'package',
          doc_summary: '',
          signature: null,
          package: entry.name,
          unloaded: true,
          manual: this.isManuallyAdded(entry.name) || undefined,
        });
      }
    }

    results.sort((a, b) => {
      const aLast = lastSegment(a.path);
      const bLast = lastSegment(b.path);
      const aPriv = isPrivateSegment(aLast) ? 1 : 0;
      const bPriv = isPrivateSegment(bLast) ? 1 : 0;
      if (aPriv !== bPriv) return aPriv - bPriv;
      const aGlyph = exactGlyph.has(a.path) ? 0 : 1;
      const bGlyph = exactGlyph.has(b.path) ? 0 : 1;
      if (aGlyph !== bGlyph) return aGlyph - bGlyph;
      const aLastLower = aLast.toLowerCase();
      const bLastLower = bLast.toLowerCase();
      const aExact = aLastLower === qLower ? 0 : 1;
      const bExact = bLastLower === qLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aP = a.path.toLowerCase();
      const bP = b.path.toLowerCase();
      const aStart = aP.startsWith(qLower) || aLastLower.startsWith(qLower) ? 0 : 1;
      const bStart = bP.startsWith(qLower) || bLastLower.startsWith(qLower) ? 0 : 1;
      if (aStart !== bStart) return aStart - bStart;
      if (!!a.unloaded !== !!b.unloaded) return a.unloaded ? 1 : -1;
      return aP.localeCompare(bP);
    });

    return results.slice(0, limit);
  }
}

/** Persist only this shard's rows so IDB never stores a whole 900MB package. */
function isolateShard(indexed: IndexedPackage, shard: string): IndexedPackage {
  if (shard === FULL_SHARD) return indexed;
  if (indexed.loadedShards.size <= 1 && indexed.loadedShards.has(shard)) return indexed;
  const pkg = indexed.cache.package;
  const entries = indexed.cache.entries.filter((entry) => {
    const id = shardIdForPath(pkg, entry.path, indexed.cache.shards);
    if (shard === ROOT_SHARD) return id === null;
    return id === shard;
  });
  const cache: PackageCache = {
    package: pkg,
    sourceUrl: indexed.cache.sourceUrl,
    generatedAt: indexed.cache.generatedAt,
    entries,
  };
  if (shard === ROOT_SHARD && indexed.cache.shards) cache.shards = indexed.cache.shards;
  return indexCache(cache, indexed.bundled, shard);
}

export const store = new PackageStore();
