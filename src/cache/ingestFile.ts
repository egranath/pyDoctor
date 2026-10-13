import type { PackageCache } from '../types';
import { looksLikeInventory, looksLikeJson } from './inventory';
import { parseCacheEntry, parsePackageCache } from './schema';

/**
 * Per-file cap for Ingest package. SymPy's walk JSON is about 1 GB, so the
 * ceiling has to sit in the multi-gigabyte range. Above INGEST_MEMORY_MAX_BYTES
 * the file is scanned entry by entry: V8 cannot JSON.parse a string much past
 * 512 MB, which a single 1 GB cache would require.
 */
export const MAX_INGEST_BYTES = 4 * 1024 * 1024 * 1024;
export const INGEST_MEMORY_MAX_BYTES = 32 * 1024 * 1024;

const HEADER_MAX_BYTES = 8 * 1024 * 1024;
const ENTRY_MAX_BYTES = 48 * 1024 * 1024;
const PROGRESS_EVERY = 50_000;

export type IngestProgress = (message: string) => void;

export function isUserUploadedCache(cache: PackageCache, catalogNames: Set<string>): boolean {
  const src = cache.sourceUrl || '';
  if (src.startsWith('walk:') || src.startsWith('upload:')) return true;
  return !catalogNames.has(cache.package);
}

export function cacheByteLength(cache: PackageCache): number {
  return new TextEncoder().encode(JSON.stringify(cache)).length;
}

function ingestLimitLabel(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded} GB`;
}

export async function packageCacheFromFile(file: File, onProgress?: IngestProgress): Promise<PackageCache> {
  if (file.size > MAX_INGEST_BYTES) {
    throw new Error(`File is larger than ${ingestLimitLabel(MAX_INGEST_BYTES)}.`);
  }
  if (file.size > INGEST_MEMORY_MAX_BYTES) {
    onProgress?.('Reading…');
    const cache = await packageCacheFromChunks(readFileChunks(file), file.name, onProgress);
    cache.uploadBytes = file.size;
    if (!cache.sourceUrl) cache.sourceUrl = `upload:${file.name}`;
    return cache;
  }
  const cache = packageCacheFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  cache.uploadBytes = file.size;
  return cache;
}

function packageCacheFromBytes(bytes: Uint8Array, fileName: string): PackageCache {
  if (looksLikeInventory(bytes)) {
    throw new Error('This is a Sphinx objects.inv file. Ingest JSON produced by walk_package.py.');
  }
  if (!looksLikeJson(bytes)) {
    throw new Error('Not a JSON package cache. Use walk_package.py to export one.');
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('JSON could not be parsed.');
  }
  if (data && typeof data === 'object' && 'info' in data && 'releases' in data) {
    throw new Error('That looks like PyPI metadata, not a walk_package cache.');
  }
  const cache = parsePackageCache(data);
  if (!cache.sourceUrl) cache.sourceUrl = `upload:${fileName}`;
  return cache;
}

async function* readFileChunks(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

const ENTRIES_KEY = new TextEncoder().encode('"entries"');

function isWs(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, start = 0): number {
  const last = hay.length - needle.length;
  outer: for (let i = start; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Uint8Array(n);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Byte index just after the `[` of the entries array, or -1 if not in `bytes` yet. */
function findEntriesArrayStart(bytes: Uint8Array): number {
  let from = 0;
  while (from <= bytes.length - ENTRIES_KEY.length) {
    const idx = indexOfBytes(bytes, ENTRIES_KEY, from);
    if (idx === -1) return -1;
    let i = idx + ENTRIES_KEY.length;
    while (i < bytes.length && isWs(bytes[i]!)) i++;
    if (i >= bytes.length) return -1;
    if (bytes[i] !== 0x3a) {
      from = idx + 1;
      continue;
    }
    i++;
    while (i < bytes.length && isWs(bytes[i]!)) i++;
    if (i >= bytes.length) return -1;
    if (bytes[i] !== 0x5b) {
      from = idx + 1;
      continue;
    }
    return i + 1;
  }
  return -1;
}

function decodeJsonString(captured: string): string {
  return JSON.parse(`"${captured}"`) as string;
}

function headerCache(header: string, fileName: string): Pick<PackageCache, 'package' | 'sourceUrl' | 'generatedAt'> {
  if (/"info"\s*:/.test(header) && /"releases"\s*:/.test(header)) {
    throw new Error('That looks like PyPI metadata, not a walk_package cache.');
  }
  const pkg = header.match(/"package"\s*:\s*"((?:\\.|[^"\\])*)"/);
  let name = '';
  try {
    name = pkg ? decodeJsonString(pkg[1]!).trim() : '';
  } catch {
    throw new Error('JSON could not be parsed.');
  }
  if (!name) throw new Error('Cache file is missing a package name.');
  const src = header.match(/"sourceUrl"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const gen = header.match(/"generatedAt"\s*:\s*"((?:\\.|[^"\\])*)"/);
  let sourceUrl = '';
  let generatedAt = '';
  try {
    sourceUrl = src ? decodeJsonString(src[1]!) : '';
    generatedAt = gen ? decodeJsonString(gen[1]!) : '';
  } catch {
    throw new Error('JSON could not be parsed.');
  }
  return {
    package: name,
    sourceUrl: sourceUrl || `upload:${fileName}`,
    generatedAt: generatedAt || new Date().toISOString(),
  };
}

/**
 * Scan a walk_package JSON file without building one giant string.
 * `chunks` may be tiny; object boundaries are tracked across them.
 */
export async function packageCacheFromChunks(
  chunks: AsyncIterable<Uint8Array>,
  fileName: string,
  onProgress?: IngestProgress,
): Promise<PackageCache> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let seeking: boolean = true;
  let prefixChecked = false;
  const found: { header: Pick<PackageCache, 'package' | 'sourceUrl' | 'generatedAt'> | null } = { header: null };
  let inObject = false;
  let inString = false;
  let escape = false;
  let depth = 0;
  const parts: Uint8Array<ArrayBufferLike>[] = [];
  let objBytes = 0;
  const entries: PackageCache['entries'] = [];
  let count = 0;
  let finished = false;

  const note = (json: string): void => {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('JSON could not be parsed.');
    }
    const entry = parseCacheEntry(data);
    if (!entry) return;
    entries.push(entry);
    count += 1;
  };

  const checkPrefix = (ended: boolean): void => {
    if (prefixChecked) return;
    const ready = ended
      || pending.length >= 512
      || looksLikeJson(pending)
      || looksLikeInventory(pending);
    if (!ready) return;
    prefixChecked = true;
    const sample = pending.subarray(0, Math.min(pending.length, 512));
    if (looksLikeInventory(sample)) {
      throw new Error('This is a Sphinx objects.inv file. Ingest JSON produced by walk_package.py.');
    }
    if (!looksLikeJson(sample)) {
      throw new Error('Not a JSON package cache. Use walk_package.py to export one.');
    }
  };

  const consume = function* (chunk: Uint8Array, ended: boolean): Generator<string> {
    pending = pending.length ? concatBytes([pending, chunk]) : chunk;
    checkPrefix(ended);
    let i = 0;
    if (seeking) {
      const start = findEntriesArrayStart(pending);
      if (start === -1) {
        if (ended || pending.length > HEADER_MAX_BYTES) {
          const preview = new TextDecoder().decode(pending.subarray(0, Math.min(pending.length, 8192)));
          if (/"info"\s*:/.test(preview) && /"releases"\s*:/.test(preview)) {
            throw new Error('That looks like PyPI metadata, not a walk_package cache.');
          }
          throw new Error('Cache file is missing an entries array.');
        }
        return;
      }
      found.header = headerCache(new TextDecoder().decode(pending.subarray(0, start)), fileName);
      i = start;
      seeking = false;
    }
    while (i < pending.length) {
      const c = pending[i]!;
      if (!inObject) {
        if (c === 0x7b) {
          inObject = true;
          depth = 1;
          inString = false;
          escape = false;
          parts.length = 0;
          objBytes = 0;
          const objStart = i;
          i++;
          while (i < pending.length) {
            const d = pending[i]!;
            if (inString) {
              if (escape) escape = false;
              else if (d === 0x5c) escape = true;
              else if (d === 0x22) inString = false;
            } else if (d === 0x22) inString = true;
            else if (d === 0x7b) depth++;
            else if (d === 0x7d) {
              depth--;
              if (depth === 0) {
                const json = new TextDecoder().decode(pending.subarray(objStart, i + 1));
                inObject = false;
                i++;
                yield json;
                break;
              }
            }
            i++;
          }
          if (inObject) {
            const slice = pending.subarray(objStart);
            parts.push(slice);
            objBytes = slice.length;
            if (objBytes > ENTRY_MAX_BYTES) {
              throw new Error('An entry in this file is larger than 48 MB.');
            }
            pending = new Uint8Array(0);
            return;
          }
          continue;
        }
        if (c === 0x5d) {
          finished = true;
          return;
        }
        i++;
        continue;
      }
      if (inString) {
        if (escape) escape = false;
        else if (c === 0x5c) escape = true;
        else if (c === 0x22) inString = false;
        i++;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b) depth++;
      else if (c === 0x7d) {
        depth--;
        if (depth === 0) {
          parts.push(pending.subarray(0, i + 1));
          objBytes += i + 1;
          if (objBytes > ENTRY_MAX_BYTES) {
            throw new Error('An entry in this file is larger than 48 MB.');
          }
          const json = new TextDecoder().decode(concatBytes(parts));
          parts.length = 0;
          objBytes = 0;
          inObject = false;
          pending = pending.subarray(i + 1);
          i = 0;
          yield json;
          continue;
        }
      }
      i++;
    }
    if (inObject) {
      parts.push(pending);
      objBytes += pending.length;
      if (objBytes > ENTRY_MAX_BYTES) {
        throw new Error('An entry in this file is larger than 48 MB.');
      }
      pending = new Uint8Array(0);
    } else if (i > 0) {
      pending = pending.subarray(i);
    }
  };

  for await (const chunk of chunks) {
    for (const json of consume(chunk, false)) {
      note(json);
      if (onProgress && count > 0 && count % PROGRESS_EVERY === 0) {
        onProgress(`Reading… ${count.toLocaleString()} entries`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (finished) break;
  }
  if (!finished) {
    for (const json of consume(new Uint8Array(0), true)) note(json);
  }
  if (!prefixChecked) {
    throw new Error('Not a JSON package cache. Use walk_package.py to export one.');
  }
  const meta = found.header;
  if (seeking || meta === null) {
    throw new Error('Cache file is missing an entries array.');
  }
  if (inObject) throw new Error('JSON could not be parsed.');
  return {
    package: meta.package,
    sourceUrl: meta.sourceUrl,
    generatedAt: meta.generatedAt,
    entries,
  };
}
