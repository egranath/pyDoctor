import type { CacheIndex, CatalogTop, PackageCache, PypiIndex } from '../types';
import { cacheAssetUrl } from '../utils';
import { inventoryToCache, looksLikeInventory, looksLikeJson } from './inventory';
import { parseCacheBundle, parsePackageCache } from './schema';
import { noteJsonParse } from './idb';

const fileCache = new Map<string, Promise<PackageCache[]>>();
const shardFileCache = new Map<string, Promise<PackageCache>>();

export async function loadCatalogTop(): Promise<CatalogTop | null> {
  try {
    const res = await fetch(cacheAssetUrl('cache/catalog-top.json'));
    if (!res.ok) return null;
    noteJsonParse('catalog-top.json');
    const data = await res.json() as CatalogTop;
    if (!data || !Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function loadPypiIndex(): Promise<PypiIndex | null> {
  try {
    const res = await fetch(cacheAssetUrl('cache/pypi-index.json'));
    if (!res.ok) return null;
    noteJsonParse('pypi-index.json');
    const data = await res.json() as PypiIndex;
    if (!data || !Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function loadBundledIndex(): Promise<CacheIndex> {
  const res = await fetch(cacheAssetUrl('cache/index.json'));
  if (!res.ok) return { packages: [] };
  const data = await res.json() as CacheIndex;
  if (!data || !Array.isArray(data.packages)) return { packages: [] };
  return data;
}

export async function loadBundledCaches(file: string): Promise<PackageCache[]> {
  let pending = fileCache.get(file);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(cacheAssetUrl(`cache/${file}`));
      if (!res.ok) {
        throw new Error(`Bundled cache ${file} was not found (${res.status}).`);
      }
      noteJsonParse(file);
      return parseCacheBundle(await res.json());
    })();
    fileCache.set(file, pending);
  }
  return pending;
}

export async function loadBundledShardFile(file: string): Promise<PackageCache> {
  let pending = shardFileCache.get(file);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(cacheAssetUrl(`cache/${file}`));
      const text = await res.text();
      const body = text.trimStart();
      if (!res.ok || (!body.startsWith('{') && !body.startsWith('['))) {
        throw new Error(`Missing bundled data: ${file}`);
      }
      noteJsonParse(file);
      return parsePackageCache(JSON.parse(body));
    })();
    shardFileCache.set(file, pending);
  }
  return pending;
}

export async function loadBundledPackage(file: string, name?: string): Promise<PackageCache> {
  const packs = await loadBundledCaches(file);
  if (name) {
    const found = packs.find((p) => p.package === name);
    if (!found) {
      throw new Error(`Package ${name} was not found in ${file}.`);
    }
    return found;
  }
  if (packs.length === 0) {
    throw new Error(`Bundled cache ${file} was empty.`);
  }
  return packs[0]!;
}

export async function fetchAsCache(packageName: string, url: string): Promise<PackageCache> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      'Could not fetch that URL (the site may block browser requests). Try ingesting the package locally with npm run ingest.',
    );
  }
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (looksLikeJson(buf)) {
    const cache = parsePackageCache(JSON.parse(new TextDecoder().decode(buf)), packageName);
    cache.package = packageName;
    cache.sourceUrl = cache.sourceUrl || url;
    return cache;
  }
  if (looksLikeInventory(buf)) {
    return inventoryToCache(buf, packageName, url);
  }
  throw new Error('That URL was not a Sphinx docs inventory or a JSON cache file.');
}
