import { store } from './cache/store';
import {
  fetchPypiInfo,
  looksLikeDistName,
  mergePypiHits,
} from './cache/pypi';
import type { ObjectDescription, PypiInfo, SearchResponse } from './types';

export class ApiRequestError extends Error {}

export async function fetchObjectByPath(path: string): Promise<ObjectDescription> {
  await store.init();
  await store.ensureLoadedForPath(path);
  let obj = store.describe(path);
  if (!obj) {
    const resolved = store.resolveQuery(path);
    if (resolved && resolved !== path) {
      await store.ensureLoadedForPath(resolved);
      obj = store.describe(resolved);
    }
  }
  if (!obj) {
    throw new ApiRequestError(`Unknown path: ${path}.`);
  }
  return obj;
}

function shouldLiveLookup(query: string): boolean {
  if (!looksLikeDistName(query)) return false;
  if (store.catalogHasName(query)) return false;
  if (query.includes('.')) {
    const root = query.split('.')[0]!;
    if (store.catalogHasName(root)) return false;
  }
  return true;
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException && err.name === 'AbortError')
    || (err instanceof Error && err.name === 'AbortError');
}

export async function search(
  query: string,
  limit?: number,
  includeUnloaded = false,
  onUpdate?: (res: SearchResponse) => void,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  await store.init();
  const q = query.trim();
  if (!q) return { query, suggestions: [] };

  let pypi: PypiInfo[] = [];
  const snap = (): SearchResponse => ({
    query,
    suggestions: store.search(query, limit ?? 20, includeUnloaded),
    pypi: pypi.length ? pypi : undefined,
  });

  const first = snap();
  onUpdate?.(first);
  if (signal?.aborted) return first;

  if (includeUnloaded) {
    await store.preloadUnloadedForSearch(query, () => onUpdate?.(snap()));
    if (signal?.aborted) return snap();
    await store.ensureUnloadedSearchExtras(query);
    if (signal?.aborted) return snap();
    onUpdate?.(snap());
    if (q.length >= 3) {
      await store.ensurePypiIndex();
      if (signal?.aborted) return snap();
      pypi = store.searchPypi(query);
      onUpdate?.(snap());
    }
  }

  if (shouldLiveLookup(q)) {
    try {
      const live = await fetchPypiInfo(q, signal);
      if (live && !store.catalogHasName(live.name)) {
        pypi = mergePypiHits(pypi, live);
        onUpdate?.(snap());
      }
    } catch (err) {
      if (isAbortError(err)) return snap();
    }
  }

  return snap();
}

export async function lookupPypi(name: string, signal?: AbortSignal): Promise<PypiInfo | null> {
  const hits = await searchPypiMeta(name, signal);
  const q = name.trim().toLowerCase();
  return hits.find((row) => row.name.toLowerCase() === q) ?? hits[0] ?? null;
}

export async function searchPypiMeta(query: string, signal?: AbortSignal): Promise<PypiInfo[]> {
  await store.init();
  const q = query.trim();
  if (!q) return [];
  let pypi: PypiInfo[] = [];
  if (q.length >= 3) {
    await store.ensurePypiIndex();
    if (signal?.aborted) return [];
    pypi = store.searchPypi(q);
  }
  if (shouldLiveLookup(q)) {
    try {
      const live = await fetchPypiInfo(q, signal);
      if (live && !store.catalogHasName(live.name)) pypi = mergePypiHits(pypi, live);
    } catch (err) {
      if (isAbortError(err)) return pypi;
    }
  }
  return pypi;
}
