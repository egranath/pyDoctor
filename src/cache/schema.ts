import type { CacheEntry, Kind, PackageCache, ShardManifestEntry } from '../types';
import { isPrivateSegment, lastSegment, parentPath } from './paths';

const KIND_PRIORITY: Record<Kind, number> = {
  function: 0,
  method: 0,
  class: 1,
  package: 2,
  module: 2,
  property: 3,
  constant: 4,
  variable: 4,
  keyword: 4,
  operator: 4,
  syntax: 4,
  call: 4,
  formatting: 4,
  punctuation: 4,
  instance: 5,
  unknown: 6,
};

export function isValidKind(value: string): value is Kind {
  return value in KIND_PRIORITY;
}

export function parseCacheEntry(item: unknown): CacheEntry | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  if (typeof row.path !== 'string' || typeof row.kind !== 'string') return null;
  if (!isValidKind(row.kind)) return null;
  const entry: CacheEntry = {
    path: row.path,
    kind: row.kind,
    dispname: typeof row.dispname === 'string' ? row.dispname : lastSegment(row.path),
    docUri: typeof row.docUri === 'string' ? row.docUri : null,
    signature: typeof row.signature === 'string' ? row.signature : null,
    doc: typeof row.doc === 'string' ? row.doc : undefined,
    doc_summary: typeof row.doc_summary === 'string' ? row.doc_summary : undefined,
  };
  if (typeof row.aliasOf === 'string' && row.aliasOf) entry.aliasOf = row.aliasOf;
  if (Array.isArray(row.searchTerms)) {
    const terms = row.searchTerms.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    if (terms.length) entry.searchTerms = terms;
  }
  return entry;
}

function readUploadBytes(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.uploadBytes !== 'number' || !Number.isFinite(raw.uploadBytes) || raw.uploadBytes < 0) {
    return undefined;
  }
  return Math.round(raw.uploadBytes);
}

export function parsePackageCache(data: unknown, packageName?: string): PackageCache {
  if (!data || typeof data !== 'object') {
    throw new Error('Cache file is not a JSON object.');
  }
  const raw = data as Record<string, unknown>;
  const name = packageName || (typeof raw.package === 'string' ? raw.package : '');
  if (!name.trim()) {
    throw new Error('Cache file is missing a package name.');
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error('Cache file is missing an entries array.');
  }
  const entries: CacheEntry[] = [];
  for (const item of raw.entries) {
    const entry = parseCacheEntry(item);
    if (entry) entries.push(entry);
  }
  const cache: PackageCache = {
    package: name.trim(),
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
    entries,
  };
  const uploadBytes = readUploadBytes(raw);
  if (uploadBytes !== undefined) cache.uploadBytes = uploadBytes;
  const shards = parseShardManifest(raw.shards);
  if (shards) {
    return {
      package: cache.package,
      sourceUrl: cache.sourceUrl,
      generatedAt: cache.generatedAt,
      shards,
      entries: cache.entries,
      ...(uploadBytes !== undefined ? { uploadBytes } : {}),
    };
  }
  return cache;
}

export function parseShardManifest(value: unknown): Record<string, ShardManifestEntry> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ShardManifestEntry> = {};
  for (const [id, item] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.file !== 'string' || !row.file) continue;
    const count = typeof row.count === 'number' && Number.isFinite(row.count) ? row.count : 0;
    out[id] = { file: row.file, count };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseCacheBundle(data: unknown): PackageCache[] {
  if (!data || typeof data !== 'object') {
    throw new Error('Cache file is not a JSON object.');
  }
  const raw = data as Record<string, unknown>;
  if (Array.isArray(raw.packages)) {
    return raw.packages.map((item) => parsePackageCache(item));
  }
  return [parsePackageCache(data)];
}

export function promoteModulesToPackages(entries: CacheEntry[]): void {
  const childKinds = new Map<string, Set<Kind>>();
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    if (!parent) continue;
    let set = childKinds.get(parent);
    if (!set) {
      set = new Set();
      childKinds.set(parent, set);
    }
    set.add(entry.kind);
  }
  for (const entry of entries) {
    if (entry.kind !== 'module') continue;
    const kids = childKinds.get(entry.path);
    if (kids && (kids.has('module') || kids.has('package'))) {
      entry.kind = 'package';
    }
  }
}

export function sortEntries(a: CacheEntry, b: CacheEntry): number {
  const aPriv = isPrivateSegment(lastSegment(a.path)) ? 1 : 0;
  const bPriv = isPrivateSegment(lastSegment(b.path)) ? 1 : 0;
  if (aPriv !== bPriv) return aPriv - bPriv;
  const ka = KIND_PRIORITY[a.kind] ?? 9;
  const kb = KIND_PRIORITY[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  return lastSegment(a.path).localeCompare(lastSegment(b.path));
}
