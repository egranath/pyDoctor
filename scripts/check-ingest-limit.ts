import { MAX_INGEST_BYTES, packageCacheFromChunks, packageCacheFromFile } from '../src/cache/ingestFile.ts';
import { cacheExceedsShardLimit, partitionLargeCache } from '../src/cache/shards.ts';
import type { CacheEntry, PackageCache } from '../src/types.ts';

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

function entry(path: string, doc: string): CacheEntry {
  const dispname = path.split('.').at(-1) ?? path;
  return {
    path,
    kind: path.split('.').length <= 2 ? 'module' : 'function',
    dispname,
    docUri: null,
    signature: '()',
    doc,
    doc_summary: 'summary',
  };
}

function cacheJson(entries: CacheEntry[]): string {
  return JSON.stringify({
    package: 'bigpkg',
    sourceUrl: 'walk:bigpkg',
    generatedAt: '2020-01-01T00:00:00.000Z',
    entries,
  });
}

async function* bytesOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

const tricky = entry('bigpkg.mod.fn', 'brace } and quote \\" and { nested }');
const small = cacheJson([
  entry('bigpkg', 'root'),
  entry('bigpkg.mod', 'module'),
  tricky,
]);

const parsed = await packageCacheFromChunks(bytesOf(small, 3), 'bigpkg.json');
assert(parsed.package === 'bigpkg', 'package name');
assert(parsed.sourceUrl === 'walk:bigpkg', 'source');
assert(parsed.entries.length === 3, `expected 3 entries, got ${parsed.entries.length}`);
assert(parsed.entries[2]?.doc === tricky.doc, 'doc with braces survived chunk splits');

const pretty = `{
  "package": "pretty",
  "sourceUrl": "walk:pretty",
  "generatedAt": "2020-01-01T00:00:00.000Z",
  "entries" : [
    {"path":"pretty.mod.fn","kind":"function","dispname":"fn","docUri":null,"doc":"ok }"}
  ]
}`;
const prettyCache = await packageCacheFromChunks(bytesOf(pretty, 5), 'pretty.json');
assert(prettyCache.package === 'pretty', 'pretty package');
assert(prettyCache.entries.length === 1, 'pretty entries');
assert(prettyCache.entries[0]?.doc === 'ok }', 'pretty doc');

let rejected = false;
try {
  await packageCacheFromChunks(bytesOf('# Sphinx inventory version 2\n', 4), 'inv.inv');
} catch (err) {
  rejected = err instanceof Error && err.message.includes('objects.inv');
}
assert(rejected, 'inventory rejected');

assert(MAX_INGEST_BYTES === 4 * 1024 * 1024 * 1024, 'cap is 4 GB');
const over = new File(['{"package":"x","entries":[]}'], 'x.json');
Object.defineProperty(over, 'size', { value: MAX_INGEST_BYTES + 1 });
let overLimit = false;
try {
  await packageCacheFromFile(over);
} catch (err) {
  overLimit = err instanceof Error && err.message === 'File is larger than 4 GB.';
}
assert(overLimit, 'over-cap message');

const doc = `${'y'.repeat(2500)}}`;
const chunks: BlobPart[] = [
  '{"package":"wide","sourceUrl":"walk:wide","generatedAt":"2020-01-01T00:00:00.000Z","entries":[',
];
const modules = 4;
const per = 3500;
for (let m = 0; m < modules; m++) {
  for (let i = 0; i < per; i++) {
    if (m || i) chunks.push(',');
    chunks.push(JSON.stringify(entry(`wide.mod${m}.fn${i}`, doc)));
  }
}
chunks.push(']}');
const wide = new File(chunks, 'wide.json', { type: 'application/json' });
assert(wide.size > 32 * 1024 * 1024, `fixture should exceed 32 MB, was ${wide.size}`);
const wideCache = await packageCacheFromFile(wide);
assert(wideCache.package === 'wide', 'wide package');
assert(wideCache.entries.length === modules * per, `wide entries ${wideCache.entries.length}`);
assert(wideCache.uploadBytes === wide.size, 'upload size recorded');
assert(wideCache.entries.at(-1)?.doc === doc, 'last doc intact');

const heavyDoc = 'z'.repeat(1024 * 1024);
const heavy: PackageCache = {
  package: 'heavy',
  sourceUrl: 'walk:heavy',
  generatedAt: '2020-01-01T00:00:00.000Z',
  uploadBytes: 99,
  entries: [
    entry('heavy', 'root'),
    entry('heavy.alpha', 'mod'),
    entry('heavy.alpha.left', 'sub'),
    ...Array.from({ length: 20 }, (_, i) => entry(`heavy.alpha.left.fn${i}`, heavyDoc)),
    entry('heavy.alpha.right', 'sub'),
    ...Array.from({ length: 20 }, (_, i) => entry(`heavy.alpha.right.fn${i}`, heavyDoc)),
    entry('heavy.beta', 'mod'),
    ...Array.from({ length: 4 }, (_, i) => entry(`heavy.beta.fn${i}`, heavyDoc)),
  ],
};
assert(cacheExceedsShardLimit(heavy), 'heavy exceeds shard limit');
const split = partitionLargeCache(heavy);
assert(split, 'heavy partitioned');
assert(split.root.uploadBytes === 99, 'upload size kept on the root');
assert(split.root.shards?.alpha, 'alpha shard');
assert(split.root.shards?.['alpha.left'], 'left shard');
assert(split.root.shards?.['alpha.right'], 'right shard');
assert(!cacheExceedsShardLimit(split.shards.get('alpha.left')!), 'left shard under the limit');
assert(!cacheExceedsShardLimit(split.shards.get('alpha.right')!), 'right shard under the limit');
assert((split.shards.get('beta')?.entries.length ?? 0) > 0, 'beta shard kept');

console.log(`ok wide=${(wide.size / (1024 * 1024)).toFixed(1)}MB entries=${wideCache.entries.length} shards=${split.shards.size}`);
