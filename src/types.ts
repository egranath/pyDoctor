export type Kind =
  | 'module'
  | 'package'
  | 'class'
  | 'function'
  | 'method'
  | 'property'
  | 'constant'
  | 'variable'
  | 'instance'
  | 'keyword'
  | 'operator'
  | 'syntax'
  | 'call'
  | 'formatting'
  | 'punctuation'
  | 'unknown';

export interface Member {
  name: string;
  kind: Kind;
  path: string;
  signature: string | null;
  doc_summary: string;
  value_preview: string | null;
  is_private: boolean;
  docUri?: string | null;
  searchTerms?: string[];
}

export interface ObjectDescription {
  package: string;
  kind: Kind;
  name: string;
  qualname: string;
  module: string;
  path: string;
  dispname: string;
  signature: string | null;
  doc: string;
  doc_summary: string;
  docUri: string | null;
  members: Member[];
  member_count: number;
  is_truncated: boolean;
  aliases: string[];
}

export interface SearchSuggestion {
  path: string;
  kind: Kind;
  doc_summary: string;
  signature: string | null;
  package: string;
  unloaded?: boolean;
  /** JSON-uploaded package, not in the bundled catalog. */
  manual?: boolean;
}

export interface PypiInfo {
  name: string;
  summary: string;
  version?: string;
  description?: string;
  keywords?: string[];
  pypiUrl: string;
  homeUrl?: string | null;
  docsUrl?: string | null;
  inventoryUrl?: string | null;
  source: 'live' | 'index';
}

export interface SearchResponse {
  query: string;
  suggestions: SearchSuggestion[];
  pypi?: PypiInfo[];
}

export interface ApiError {
  error: string;
}

export interface CacheEntry {
  path: string;
  kind: Kind;
  dispname: string;
  docUri: string | null;
  signature?: string | null;
  doc?: string;
  doc_summary?: string;
  /** Canonical inventory path when this row is a re-export / alias. */
  aliasOf?: string | null;
  /** Extra address-bar / filter tokens (glyphs, aliases, informal names). */
  searchTerms?: string[];
}

export interface ShardManifestEntry {
  file: string;
  count: number;
}

export interface PackageCache {
  package: string;
  sourceUrl: string;
  generatedAt: string;
  entries: CacheEntry[];
  /** Present on sharded roots: top-level module id → shard file. */
  shards?: Record<string, ShardManifestEntry>;
  /** Byte length of the JSON file the user uploaded. */
  uploadBytes?: number;
}

export interface CacheIndexEntry {
  name: string;
  file: string;
  loadByDefault?: boolean;
  pinned?: boolean;
  /** Cache timestamp used as the IndexedDB version key. */
  generatedAt?: string;
  /** True when `file` is a small root + shard manifest, not the full inventory. */
  sharded?: boolean;
  /** Alternate search names; suggestions always use `name`. */
  aliases?: string[];
}

export interface CatalogTopEntry {
  path: string;
  package: string;
  kind: Kind;
  doc_summary?: string;
}

export interface CatalogTop {
  generatedAt: string;
  entries: CatalogTopEntry[];
}

export interface PypiIndexEntry {
  name: string;
  summary: string;
  version?: string;
  keywords?: string[];
  docsUrl?: string;
  homeUrl?: string;
}

export interface PypiIndex {
  generatedAt: string;
  entries: PypiIndexEntry[];
}

export interface CacheIndex {
  packages: CacheIndexEntry[];
}

export interface CacheBundle {
  packages: PackageCache[];
}
