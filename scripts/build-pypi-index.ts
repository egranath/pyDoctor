#!/usr/bin/env npx tsx
/**
 * Bake a slim PyPI metadata index (top downloads + catalog third-party names).
 *
 * Usage: npm run pypi-index
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CacheIndex, PypiIndex, PypiIndexEntry } from '../src/types.ts';
import { pep503Normalize } from './package-aliases.ts';

const USER_AGENT = 'docs-browser-ingest/1.0';
const TOP_URL = 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json';
const CONCURRENCY = 8;
const SKIP_FILES = new Set(['stdlib.json', 'builtins.json', 'demo.json', 'syntax.json']);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');

interface HugovkRow {
  project?: string;
  download_count?: number;
}

interface HugovkDump {
  rows?: HugovkRow[];
}

interface WarehouseInfo {
  name?: string;
  summary?: string;
  version?: string;
  keywords?: string | string[] | null;
  home_page?: string | null;
  docs_url?: string | null;
  project_urls?: Record<string, string> | null;
}

interface WarehouseProject {
  info?: WarehouseInfo;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

function firstProjectUrl(urls: Record<string, string> | null | undefined, test: RegExp): string | undefined {
  if (!urls) return undefined;
  for (const [key, value] of Object.entries(urls)) {
    if (test.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function asKeywords(value: string | string[] | null | undefined): string[] | undefined {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : [];
  const cleaned = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
  return cleaned.length ? cleaned : undefined;
}

function cleanUrl(value: string | null | undefined): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'UNKNOWN') return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

async function fetchWarehouse(name: string): Promise<PypiIndexEntry | null> {
  let delay = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchText(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (attempt < 3 && res.status >= 500) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      console.warn(`  skip ${name}: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json() as WarehouseProject;
    const info = data.info;
    const distName = typeof info?.name === 'string' ? info.name.trim() : name;
    if (!distName) return null;
    const docsUrl = cleanUrl(
      firstProjectUrl(info?.project_urls, /doc/i)
      || info?.docs_url
      || firstProjectUrl(info?.project_urls, /home|website/i),
    );
    const homeUrl = cleanUrl(info?.home_page || firstProjectUrl(info?.project_urls, /home|website/i));
    const entry: PypiIndexEntry = {
      name: distName,
      summary: typeof info?.summary === 'string' ? info.summary.trim() : '',
    };
    if (typeof info?.version === 'string' && info.version) entry.version = info.version;
    const keywords = asKeywords(info?.keywords);
    if (keywords) entry.keywords = keywords;
    if (docsUrl) entry.docsUrl = docsUrl;
    if (homeUrl) entry.homeUrl = homeUrl;
    return entry;
  }
  console.warn(`  skip ${name}: too many retries`);
  return null;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function buildPypiIndex(dir = cacheDir): Promise<void> {
  const indexPath = join(dir, 'index.json');
  const raw = JSON.parse(await readFile(indexPath, 'utf8')) as CacheIndex;
  const packages = Array.isArray(raw.packages) ? raw.packages : [];

  const blocked = new Set<string>();
  const catalogThird: string[] = [];
  for (const pkg of packages) {
    const key = pep503Normalize(pkg.name);
    if (SKIP_FILES.has(pkg.file)) {
      blocked.add(key);
      continue;
    }
    catalogThird.push(pkg.name);
  }

  const hugovkRes = await fetchText(TOP_URL);
  if (!hugovkRes.ok) {
    throw new Error(`Failed to fetch top PyPI list: ${hugovkRes.status} ${hugovkRes.statusText}`);
  }
  const hugovk = await hugovkRes.json() as HugovkDump;
  const rows = Array.isArray(hugovk.rows) ? hugovk.rows : [];

  const wanted: string[] = [];
  const seen = new Set<string>();
  const addName = (name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = pep503Normalize(trimmed);
    if (!key || seen.has(key) || blocked.has(key)) return;
    seen.add(key);
    wanted.push(trimmed);
  };
  for (const row of rows) {
    if (typeof row.project === 'string') addName(row.project);
  }
  for (const name of catalogThird) addName(name);

  console.log(`PyPI index: fetching metadata for ${wanted.length} projects…`);
  let done = 0;
  const fetched = await mapPool(wanted, CONCURRENCY, async (name) => {
    const entry = await fetchWarehouse(name);
    done += 1;
    if (done % 250 === 0 || done === wanted.length) {
      console.log(`  ${done}/${wanted.length}`);
    }
    return entry;
  });

  const entries: PypiIndexEntry[] = [];
  const outSeen = new Set<string>();
  for (const entry of fetched) {
    if (!entry?.name) continue;
    const key = pep503Normalize(entry.name);
    if (blocked.has(key) || outSeen.has(key)) continue;
    outSeen.add(key);
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const payload: PypiIndex = {
    generatedAt: new Date().toISOString(),
    entries,
  };
  await writeFile(join(dir, 'pypi-index.json'), `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`PyPI index: wrote ${entries.length} entries.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildPypiIndex().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
