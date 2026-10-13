import type { PypiIndexEntry, PypiInfo } from '../types';
import { lookupNamesFor, pep503Normalize } from './packageAliases';

const DESC_CAP = 2000;
const FETCH_MS = 8000;
const sessionCache = new Map<string, PypiInfo | null>();

const DIST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const PYPI_SUGGESTION_LIMIT = 8;

interface WarehouseInfo {
  name?: string;
  summary?: string;
  version?: string;
  description?: string;
  keywords?: string | string[] | null;
  home_page?: string | null;
  package_url?: string;
  project_url?: string;
  docs_url?: string | null;
  project_urls?: Record<string, string> | null;
}

interface WarehouseProject {
  info?: WarehouseInfo;
}

/** Single token that could be a PyPI project. Rejects `os.path.join`-style paths. */
export function looksLikeDistName(query: string): boolean {
  const q = query.trim();
  if (!q || /\s/.test(q)) return false;
  if (!DIST_NAME_RE.test(q)) return false;
  if (q.split('.').length >= 3) return false;
  return true;
}

export function guessInventoryUrl(
  docsUrl?: string | null,
  homeUrl?: string | null,
): string | null {
  for (const raw of [docsUrl, homeUrl]) {
    if (!raw) continue;
    const guessed = inventoryUrlFromDocs(raw);
    if (guessed) return guessed;
  }
  return null;
}

function inventoryUrlFromDocs(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname || '/';
  if (path.endsWith('/objects.inv') || path.endsWith('objects.inv')) {
    return url.href;
  }
  const host = url.hostname.toLowerCase();
  const rtd = host.endsWith('readthedocs.io') || host.endsWith('readthedocs.org');
  const docsHost = host.startsWith('docs.') || host.includes('readthedocs');
  const pathLooksLikeDocs = /\/(en|stable|latest|doc|docs)(\/|$)/i.test(path);
  if (!rtd && !docsHost && !pathLooksLikeDocs) return null;
  let dir = path;
  if (dir.endsWith('.html')) {
    const slash = dir.lastIndexOf('/');
    dir = slash === -1 ? '/' : dir.slice(0, slash + 1);
  } else if (!dir.endsWith('/')) {
    dir += '/';
  }
  return `${url.origin}${dir}objects.inv`;
}

function firstProjectUrl(urls: Record<string, string> | null | undefined, test: RegExp): string | null {
  if (!urls) return null;
  for (const [key, value] of Object.entries(urls)) {
    if (test.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function asKeywords(value: string | string[] | null | undefined): string[] | undefined {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : [];
  const cleaned = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  return cleaned.length ? cleaned : undefined;
}

function toPlainDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/<[^>]+>/g, ' ').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!stripped) return undefined;
  return stripped.length > DESC_CAP ? `${stripped.slice(0, DESC_CAP).trimEnd()}…` : stripped;
}

function cleanUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'UNKNOWN') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function pypiInfoFromIndex(entry: PypiIndexEntry): PypiInfo {
  const docsUrl = cleanUrl(entry.docsUrl);
  const homeUrl = cleanUrl(entry.homeUrl);
  return {
    name: entry.name,
    summary: entry.summary || '',
    version: entry.version,
    keywords: entry.keywords,
    pypiUrl: `https://pypi.org/project/${entry.name}/`,
    homeUrl,
    docsUrl,
    inventoryUrl: guessInventoryUrl(docsUrl, homeUrl),
    source: 'index',
  };
}

export function pypiInfoFromWarehouse(info: WarehouseInfo, source: PypiInfo['source'] = 'live'): PypiInfo | null {
  const name = typeof info.name === 'string' ? info.name.trim() : '';
  if (!name) return null;
  const docsUrl = cleanUrl(
    firstProjectUrl(info.project_urls, /doc/i)
    || info.docs_url
    || firstProjectUrl(info.project_urls, /home|website|source/i),
  );
  const homeUrl = cleanUrl(info.home_page || firstProjectUrl(info.project_urls, /home|website/i));
  const pypiUrl = cleanUrl(info.package_url || info.project_url) || `https://pypi.org/project/${name}/`;
  return {
    name,
    summary: typeof info.summary === 'string' ? info.summary.trim() : '',
    version: typeof info.version === 'string' ? info.version : undefined,
    description: toPlainDescription(typeof info.description === 'string' ? info.description : undefined),
    keywords: asKeywords(info.keywords),
    pypiUrl,
    homeUrl,
    docsUrl,
    inventoryUrl: guessInventoryUrl(docsUrl, homeUrl),
    source,
  };
}

function mergeSignals(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  if (outer?.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = (): void => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  ctrl.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }, { once: true });
  return ctrl.signal;
}

async function fetchWarehouse(name: string, signal?: AbortSignal): Promise<PypiInfo | null> {
  const key = pep503Normalize(name);
  if (sessionCache.has(key)) return sessionCache.get(key) ?? null;
  let res: Response;
  try {
    res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      signal: mergeSignals(FETCH_MS, signal),
    });
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    sessionCache.set(key, null);
    return null;
  }
  if (res.status === 404) {
    sessionCache.set(key, null);
    return null;
  }
  if (!res.ok) {
    sessionCache.set(key, null);
    return null;
  }
  let data: WarehouseProject;
  try {
    data = await res.json() as WarehouseProject;
  } catch {
    sessionCache.set(key, null);
    return null;
  }
  const info = data.info ? pypiInfoFromWarehouse(data.info, 'live') : null;
  sessionCache.set(key, info);
  if (info) sessionCache.set(pep503Normalize(info.name), info);
  return info;
}

/** Live Warehouse lookup. 404 / network → null. Aborts propagate. */
export async function fetchPypiInfo(name: string, signal?: AbortSignal): Promise<PypiInfo | null> {
  const query = name.trim();
  if (!query) return null;
  for (const candidate of lookupNamesFor(query)) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const cached = sessionCache.get(pep503Normalize(candidate));
    if (cached !== undefined) {
      if (cached) return cached;
      continue;
    }
    const hit = await fetchWarehouse(candidate, signal);
    if (hit) return hit;
  }
  return null;
}

export function mergePypiHits(baked: PypiInfo[], live: PypiInfo | null, limit = PYPI_SUGGESTION_LIMIT): PypiInfo[] {
  if (!live) return baked.slice(0, limit);
  const liveKey = pep503Normalize(live.name);
  const rest = baked.filter((row) => pep503Normalize(row.name) !== liveKey);
  return [live, ...rest].slice(0, limit);
}
