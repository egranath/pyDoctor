#!/usr/bin/env npx tsx
/**
 * Ingest Python stdlib + builtins and common third-party inventories into public/cache.
 *
 * Usage: npm run ingest:defaults
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackageCache } from '../src/cache/schema.ts';
import {
  inventoryPayloadOffset,
  looksLikeInventory,
  parseInventoryBody,
  groupPythonLibraryCaches,
} from '../src/cache/inventory.ts';
import type { CacheIndex, CacheIndexEntry, PackageCache } from '../src/types.ts';
import { buildCatalogTop } from './build-catalog-top.ts';
import { buildSyntax } from './build-syntax.ts';
import { aliasesFor } from './package-aliases.ts';
import { runShardCache } from './shard-cache.ts';

const PYTHON_INV = 'https://docs.python.org/3/objects.inv';

/** Packages that appear loaded in the sidebar on a fresh visit (not pinned). */
const LOAD_BY_DEFAULT = new Set([
  'sys',
  'site',
  'itertools',
  'os',
  'collections',
  'operator',
  'functools',
  'math',
  'sympy',
  'numpy',
]);

type ThirdPartySpec = {
  name: string;
  urls: string[];
  required: boolean;
  /** Import + dir/pkgutil walk. Used when there is no objects.inv. */
  walk?: boolean;
};

const THIRD_PARTY: ThirdPartySpec[] = [
  { name: 'numpy', urls: ['https://numpy.org/doc/stable/objects.inv'], required: true },
  { name: 'sympy', urls: ['https://docs.sympy.org/latest/objects.inv'], required: true },
  { name: 'pandas', urls: ['https://pandas.pydata.org/docs/objects.inv'], required: true },
  { name: 'matplotlib', urls: ['https://matplotlib.org/stable/objects.inv'], required: true },
  { name: 'networkx', urls: ['https://networkx.org/documentation/stable/objects.inv'], required: true },
  {
    name: 'scipy',
    urls: [
      'https://docs.scipy.org/doc/scipy/objects.inv',
      'https://docs.scipy.org/doc/scipy/reference/objects.inv',
    ],
    required: false,
  },
  { name: 'requests', urls: ['https://requests.readthedocs.io/en/latest/objects.inv'], required: false },
  { name: 'sklearn', urls: ['https://scikit-learn.org/stable/objects.inv'], required: false },
  { name: 'pyperclip', urls: [], required: false, walk: true },
  { name: 'numba', urls: ['https://numba.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'rich', urls: ['https://rich.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'torch', urls: ['https://pytorch.org/docs/stable/objects.inv'], required: false },
  { name: 'pydantic', urls: ['https://docs.pydantic.dev/latest/objects.inv'], required: false },
  { name: 'flask', urls: ['https://flask.palletsprojects.com/en/stable/objects.inv'], required: false },
  { name: 'django', urls: ['https://docs.djangoproject.com/en/stable/_objects/'], required: false },
  { name: 'PIL', urls: ['https://pillow.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'seaborn', urls: ['https://seaborn.pydata.org/objects.inv'], required: false },
  { name: 'pytest', urls: ['https://docs.pytest.org/en/stable/objects.inv'], required: false },
  { name: 'click', urls: ['https://click.palletsprojects.com/en/stable/objects.inv'], required: false },
  { name: 'sqlalchemy', urls: ['https://docs.sqlalchemy.org/en/20/objects.inv'], required: false },
  { name: 'IPython', urls: ['https://ipython.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'xarray', urls: ['https://docs.xarray.dev/en/stable/objects.inv'], required: false },
  { name: 'dask', urls: ['https://docs.dask.org/en/stable/objects.inv'], required: false },
  { name: 'aiohttp', urls: ['https://docs.aiohttp.org/en/stable/objects.inv'], required: false },
  { name: 'attrs', urls: ['https://www.attrs.org/en/stable/objects.inv'], required: false },
  { name: 'statsmodels', urls: ['https://www.statsmodels.org/stable/objects.inv'], required: false },
  { name: 'skimage', urls: ['https://scikit-image.org/docs/stable/objects.inv'], required: false },
  { name: 'jinja2', urls: ['https://jinja.palletsprojects.com/en/stable/objects.inv'], required: false },
  { name: 'joblib', urls: ['https://joblib.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'jax', urls: ['https://docs.jax.dev/en/latest/objects.inv'], required: false },
  { name: 'bokeh', urls: ['https://docs.bokeh.org/en/latest/objects.inv'], required: false },
  { name: 'tornado', urls: ['https://www.tornadoweb.org/en/stable/objects.inv'], required: false },
  { name: 'fastapi', urls: ['https://fastapi.tiangolo.com/objects.inv'], required: false },
  { name: 'dateutil', urls: ['https://dateutil.readthedocs.io/en/stable/objects.inv'], required: false },
  { name: 'packaging', urls: ['https://packaging.pypa.io/en/stable/objects.inv'], required: false },
  {
    name: 'bs4',
    urls: [
      'https://www.crummy.com/software/BeautifulSoup/bs4/doc/objects.inv',
      'https://beautiful-soup-4.readthedocs.io/en/latest/objects.inv',
    ],
    required: false,
    walk: true,
  },
];

const SKIP_PYTHON_ROOTS = new Set([
  'index',
  'glossary',
  'license',
  'copyright',
  'intro',
  'tutorial',
  'using',
  'whatsnew',
  'faq',
  'howto',
  'installing',
  'distributing',
  'extending',
  'reference',
  'datamodel',
  'expressions',
  'compound_stmts',
  'simple_stmts',
  'lexical_analysis',
  'introduction',
  'executionmodel',
  'importsystem',
  'interactive',
]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'public', 'cache');
const venvPython = join(root, '.venv', 'bin', 'python');

function pythonBin(): string {
  return process.env.DOCS_BROWSER_PYTHON || (existsSync(venvPython) ? venvPython : 'python3');
}

function spawnProcess(bin: string, args: string[], extraEnv?: Record<string, string | undefined>): Promise<void> {
  const env = { ...process.env, ...extraEnv };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function spawnPython(args: string[], extraEnv?: Record<string, string | undefined>): Promise<void> {
  return spawnProcess(pythonBin(), args, extraEnv);
}

async function ensureIngestVenv(): Promise<void> {
  if (process.env.DOCS_BROWSER_PYTHON || existsSync(venvPython)) return;
  console.log('Creating pyDoctor/.venv for ingest…');
  await spawnProcess('python3', ['-m', 'venv', '--system-site-packages', join(root, '.venv')]);
}

async function pipInstallEnrichDeps(): Promise<void> {
  await ensureIngestVenv();
  const req = join(root, 'scripts', 'requirements-ingest.txt');
  console.log('Installing ingest Python packages…');
  await spawnPython(['-m', 'pip', 'install', '-q', '-r', req]);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'docs-browser-ingest/1.0' },
  });
  if (!res.ok) throw new Error(`Fetch failed ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function walkInstalledPackage(name: string): Promise<PackageCache> {
  const script = join(root, 'scripts', 'walk_package.py');
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin(), [script, name], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`walk_package.py ${name} exited with ${code}`));
    });
  });
  return parsePackageCache(JSON.parse(raw), name);
}

async function fetchThirdParty(spec: ThirdPartySpec): Promise<PackageCache> {
  if (spec.walk && spec.urls.length === 0) {
    console.log(`Walking ${spec.name}…`);
    return walkInstalledPackage(spec.name);
  }
  const errors: string[] = [];
  for (const url of spec.urls) {
    try {
      console.log(`Fetching ${spec.name}…`);
      return parseInventoryBody(inflateInventory(await fetchBytes(url)), spec.name, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${message}`);
      console.warn(`  ${spec.name} failed at ${url}: ${message}`);
    }
  }
  if (spec.walk) {
    console.warn(`  falling back to import-walk for ${spec.name}`);
    return walkInstalledPackage(spec.name);
  }
  throw new Error(`Could not ingest ${spec.name} (${errors.join('; ')})`);
}

function inflateInventory(buf: Uint8Array): string {
  if (!looksLikeInventory(buf)) {
    throw new Error('URL was not a Sphinx objects.inv file.');
  }
  const headerText = new TextDecoder().decode(buf.slice(0, 512));
  if (!headerText.startsWith('# Sphinx inventory version 2')) {
    throw new Error('Only Sphinx objects.inv version 2 is supported.');
  }
  const payload = buf.slice(inventoryPayloadOffset(buf));
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(inflateSync(payload));
  } catch {
    inflated = new Uint8Array(inflateRawSync(payload));
  }
  return new TextDecoder().decode(inflated);
}

function isModuleName(name: string): boolean {
  return /^_?[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function writeMinified(path: string, data: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(data)}\n`, 'utf8');
}

function enrichDocs(files?: string[], extraEnv?: Record<string, string | undefined>): Promise<void> {
  const script = join(root, 'scripts', 'enrich_docs.py');
  return spawnPython([script, cacheDir, ...(files ?? [])], extraEnv);
}

function mergeWalk(files?: string[]): Promise<void> {
  const script = join(root, 'scripts', 'merge_walk.py');
  return spawnPython([script, cacheDir, ...(files ?? [])]);
}

async function loadCachedPackage(file: string, name?: string): Promise<PackageCache> {
  const raw = JSON.parse(await readFile(join(cacheDir, file), 'utf8')) as unknown;
  return parsePackageCache(raw, name);
}

async function main(): Promise<void> {
  const skipExisting = process.argv.includes('--skip-existing');
  await mkdir(cacheDir, { recursive: true });
  try {
    await pipInstallEnrichDeps();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`pip install failed (${message}); enrich will scrape HTML for missing docs.`);
  }

  const builtinsPath = join(cacheDir, 'builtins.json');
  const stdlibPath = join(cacheDir, 'stdlib.json');
  let builtins: PackageCache;
  let stdlib: PackageCache[];
  if (skipExisting && existsSync(builtinsPath) && existsSync(stdlibPath)) {
    console.log('Keeping cached Python inventory…');
    builtins = await loadCachedPackage('builtins.json', 'builtins');
    const bundled = JSON.parse(await readFile(stdlibPath, 'utf8')) as { packages?: unknown[] };
    stdlib = Array.isArray(bundled.packages)
      ? bundled.packages.map((item) => parsePackageCache(item))
      : [];
  } else {
    console.log('Fetching Python inventory…');
    const pythonText = inflateInventory(await fetchBytes(PYTHON_INV));
    const pythonGenerated = new Date().toISOString();
    const grouped = groupPythonLibraryCaches(pythonText, PYTHON_INV);
    builtins = { ...grouped.builtins, generatedAt: pythonGenerated };
    if (!builtins.entries.some((e) => e.path !== 'builtins')) {
      throw new Error('Python inventory did not contain builtin objects.');
    }
    stdlib = grouped.stdlib
      .map((cache) => ({ ...cache, generatedAt: pythonGenerated }))
      .filter((cache) => {
        if (SKIP_PYTHON_ROOTS.has(cache.package)) return false;
        if (!isModuleName(cache.package)) return false;
        return cache.entries.some((e) => e.path !== cache.package);
      });
  }

  const thirdParty: PackageCache[] = [];
  const newThirdPartyFiles: string[] = [];
  for (const spec of THIRD_PARTY) {
    const cachedFile = `${spec.name}.json`;
    const cachedPath = join(cacheDir, cachedFile);
    if (skipExisting && existsSync(cachedPath)) {
      try {
        thirdParty.push(await loadCachedPackage(cachedFile, spec.name));
        console.log(`Keeping cached ${spec.name}`);
        continue;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  cached ${spec.name} unreadable (${message}); refetching`);
      }
    }
    try {
      const cache = await fetchThirdParty(spec);
      thirdParty.push(cache);
      newThirdPartyFiles.push(`${cache.package}.json`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (spec.required) throw err;
      console.warn(`Skipping ${spec.name}: ${message}`);
    }
  }

  const stdlibPayload = { packages: stdlib };
  const stdlibBytes = Buffer.byteLength(JSON.stringify(stdlibPayload), 'utf8');
  console.log(`Stdlib bundle: ${stdlib.length} modules (${stdlibBytes} bytes).`);

  const demoPath = join(cacheDir, 'demo.json');
  let demo: PackageCache | null = null;
  try {
    demo = JSON.parse(await readFile(demoPath, 'utf8')) as PackageCache;
  } catch {
    demo = null;
  }

  if (!skipExisting || !existsSync(builtinsPath) || !existsSync(stdlibPath)) {
    await writeMinified(builtinsPath, builtins);
    await writeMinified(stdlibPath, stdlibPayload);
  }
  for (const cache of thirdParty) {
    const file = `${cache.package}.json`;
    if (skipExisting && existsSync(join(cacheDir, file)) && !newThirdPartyFiles.includes(file)) {
      continue;
    }
    await writeMinified(join(cacheDir, file), cache);
  }
  if (skipExisting) {
    if (newThirdPartyFiles.length > 0) {
      await mergeWalk(newThirdPartyFiles);
      await enrichDocs(newThirdPartyFiles, { DOCS_BROWSER_SKIP_SCRAPE: '1' });
    } else console.log('No new packages to enrich.');
  } else {
    await mergeWalk();
    await enrichDocs();
  }

  try {
    await unlink(join(cacheDir, 'json.json'));
  } catch {
    // previous single-module cache may not exist
  }

  const syntax = await buildSyntax(cacheDir);

  const packages: CacheIndexEntry[] = [
    {
      name: 'builtins',
      file: 'builtins.json',
      loadByDefault: true,
      generatedAt: builtins.generatedAt,
    },
    {
      name: 'syntax',
      file: 'syntax.json',
      loadByDefault: true,
      generatedAt: syntax.generatedAt,
    },
    ...stdlib.map((c) => {
      const entry: CacheIndexEntry = { name: c.package, file: 'stdlib.json' };
      if (LOAD_BY_DEFAULT.has(c.package)) entry.loadByDefault = true;
      if (c.generatedAt) entry.generatedAt = c.generatedAt;
      return entry;
    }),
    ...thirdParty.map((c) => {
      const entry: CacheIndexEntry = { name: c.package, file: `${c.package}.json` };
      if (LOAD_BY_DEFAULT.has(c.package)) entry.loadByDefault = true;
      if (c.generatedAt) entry.generatedAt = c.generatedAt;
      if (c.shards && Object.keys(c.shards).length > 0) entry.sharded = true;
      const aliases = aliasesFor(c.package);
      if (aliases) entry.aliases = aliases;
      return entry;
    }),
  ];
  if (demo && typeof demo.package === 'string') {
    packages.push({ name: demo.package, file: 'demo.json' });
  }
  packages.sort((a, b) => {
    if (a.name === 'builtins') return -1;
    if (b.name === 'builtins') return 1;
    if (a.name === 'syntax') return -1;
    if (b.name === 'syntax') return 1;
    return a.name.localeCompare(b.name);
  });

  const index: CacheIndex = { packages };
  await writeFile(join(cacheDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  console.log('Sharding large cache files…');
  await runShardCache();
  await buildCatalogTop(cacheDir);

  const thirdPartySummary = thirdParty
    .map((c) => `${c.package} (${c.entries.length})`)
    .join(', ');
  console.log(`Wrote builtins (${builtins.entries.length} entries); ${thirdPartySummary}`);
  console.log(`Index: ${packages.length} packages`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
