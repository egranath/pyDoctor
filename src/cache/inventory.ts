import type { CacheEntry, Kind, PackageCache } from '../types';
import { lastSegment } from './paths';
import { promoteModulesToPackages } from './schema';

function headerEndOffset(data: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      count++;
      if (count === 4) return i + 1;
    }
  }
  throw new Error('Invalid Sphinx inventory header (expected 4 header lines).');
}

export function inventoryPayloadOffset(data: Uint8Array): number {
  return headerEndOffset(data);
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('zlib inflate requires DecompressionStream (browser) or Node ingest.');
  }
  const tryFormat = async (format: CompressionFormat): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await tryFormat('deflate');
  } catch {
    return await tryFormat('deflate-raw');
  }
}

export function kindFromSphinx(domainRole: string): Kind | null {
  const [domain, roleRaw] = domainRole.includes(':')
    ? (domainRole.split(':', 2) as [string, string])
    : (['py', domainRole] as [string, string]);
  if (domain !== 'py') return null;
  switch (roleRaw) {
    case 'mod':
    case 'module':
      return 'module';
    case 'class':
    case 'exc':
    case 'exception':
    case 'type':
      return 'class';
    case 'func':
    case 'function':
    case 'decorator':
    case 'deco':
      return 'function';
    case 'meth':
    case 'method':
    case 'classmethod':
    case 'staticmethod':
      return 'method';
    case 'attr':
    case 'attribute':
    case 'property':
      return 'property';
    case 'data':
    case 'const':
    case 'constant':
      return 'constant';
    case 'obj':
    case 'object':
      return 'variable';
    default:
      return 'unknown';
  }
}

function resolveDocUri(inventoryUrl: string, uri: string, name: string): string | null {
  if (!uri || uri === '-') return null;
  const expanded = uri.replace(/\$/g, name);
  try {
    const inv = new URL(inventoryUrl);
    const docsRoot = new URL('./', inv);
    return new URL(expanded, docsRoot).href;
  } catch {
    return expanded;
  }
}

function belongsToPackage(path: string, packageName: string): boolean {
  return path === packageName || path.startsWith(`${packageName}.`);
}

function parseInventoryEntries(text: string, sourceUrl: string, packageName?: string): CacheEntry[] {
  const entries: CacheEntry[] = [];
  const seen = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const name = match[1]!;
    const domainRole = match[2]!;
    const uri = match[4]!;
    const dispRaw = match[5]!.trim();
    if (packageName && !belongsToPackage(name, packageName)) continue;
    const kind = kindFromSphinx(domainRole);
    if (!kind) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({
      path: name,
      kind,
      dispname: dispRaw === '-' || dispRaw === '' ? lastSegment(name) : dispRaw,
      docUri: resolveDocUri(sourceUrl, uri, name),
    });
  }
  return entries;
}

export function finalizePackageCache(
  packageName: string,
  sourceUrl: string,
  entries: CacheEntry[],
): PackageCache {
  const list = [...entries];
  if (!list.some((e) => e.path === packageName)) {
    list.unshift({
      path: packageName,
      kind: 'package',
      dispname: packageName,
      docUri: null,
    });
  }
  promoteModulesToPackages(list);
  const root = list.find((e) => e.path === packageName);
  if (root && root.kind === 'module') root.kind = 'package';
  return {
    package: packageName,
    sourceUrl,
    generatedAt: new Date().toISOString(),
    entries: list,
  };
}

/** True when the cache is only the synthetic package root (no py: API objects). */
export function isEmptyApiCache(cache: PackageCache): boolean {
  return !cache.entries.some((entry) => entry.path !== cache.package);
}

export function parseInventoryBody(
  text: string,
  packageName: string,
  sourceUrl: string,
): PackageCache {
  return finalizePackageCache(packageName, sourceUrl, parseInventoryEntries(text, sourceUrl, packageName));
}

/** Split a Sphinx inventory into one cache per top-level name (`json`, `os`, …). */
export function parseInventoryByTopLevel(text: string, sourceUrl: string): PackageCache[] {
  const grouped = new Map<string, CacheEntry[]>();
  for (const entry of parseInventoryEntries(text, sourceUrl)) {
    const root = entry.path.split('.')[0]!;
    const list = grouped.get(root) ?? [];
    list.push(entry);
    grouped.set(root, list);
  }
  return [...grouped.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => finalizePackageCache(name, sourceUrl, grouped.get(name)!));
}

function isBuiltinDocUri(uri: string | null): boolean {
  if (!uri) return false;
  return (
    uri.includes('/builtins/')
    || uri.includes('/library/functions.html')
    || uri.includes('/library/stdtypes.html')
    || uri.includes('/library/exceptions.html')
    || uri.includes('/library/constants.html')
  );
}

/**
 * Python's objects.inv stores builtin names unprefixed (`open`, `str`) and
 * stdlib names under their module. Group those into `builtins` plus one cache
 * per top-level library module.
 */
export function groupPythonLibraryCaches(text: string, sourceUrl: string): {
  builtins: PackageCache;
  stdlib: PackageCache[];
} {
  const entries = parseInventoryEntries(text, sourceUrl);
  const moduleNames = entries
    .filter((e) => e.kind === 'module' || e.kind === 'package')
    .map((e) => e.path)
    .sort((a, b) => b.length - a.length);

  const grouped = new Map<string, CacheEntry[]>();
  const add = (pkg: string, entry: CacheEntry): void => {
    const list = grouped.get(pkg) ?? [];
    list.push(entry);
    grouped.set(pkg, list);
  };

  for (const entry of entries) {
    if (
      isBuiltinDocUri(entry.docUri)
      || entry.path === 'builtins'
      || entry.path.startsWith('builtins.')
    ) {
      const path = entry.path === 'builtins' || entry.path.startsWith('builtins.')
        ? entry.path
        : `builtins.${entry.path}`;
      add('builtins', { ...entry, path });
      continue;
    }
    const match = moduleNames.find((m) => entry.path === m || entry.path.startsWith(`${m}.`));
    if (!match) continue;
    add(match.split('.')[0]!, entry);
  }

  const builtinsEntries = grouped.get('builtins') ?? [];
  grouped.delete('builtins');
  const stdlib = [...grouped.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => finalizePackageCache(name, sourceUrl, grouped.get(name)!));
  return {
    builtins: finalizePackageCache('builtins', sourceUrl, builtinsEntries),
    stdlib,
  };
}

export async function inventoryToCache(
  bytes: Uint8Array,
  packageName: string,
  sourceUrl: string,
): Promise<PackageCache> {
  const headerBytes = bytes.slice(0, Math.min(bytes.length, 512));
  const headerText = new TextDecoder().decode(headerBytes);
  if (!headerText.startsWith('# Sphinx inventory version 2')) {
    throw new Error('Only Sphinx inventory version 2 is supported.');
  }
  const payload = bytes.slice(headerEndOffset(bytes));
  const inflated = await inflateZlib(payload);
  return parseInventoryBody(new TextDecoder().decode(inflated), packageName, sourceUrl);
}

export function looksLikeInventory(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 40));
  return prefix.startsWith('# Sphinx inventory');
}

export function looksLikeJson(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    return c === 0x7b;
  }
  return false;
}
