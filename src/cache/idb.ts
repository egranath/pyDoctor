import type { PackageCache } from '../types';
import {
  type StoredShard,
  shardRecordId,
} from './shards';

const IDB_NAME = 'docs-browser';
const IDB_VERSION = 2;
const PACKAGES_STORE = 'packages';
const SHARDS_STORE = 'shards';
/** First open + upgrade can take hundreds of ms; 150ms was disabling IDB in real tabs. */
const IDB_OPEN_TIMEOUT_MS = 2000;
/** Structured-clone of a ~10MB shard can exceed a few hundred ms. */
const IDB_GET_TIMEOUT_MS = 2000;
/** Module shards from a ~1GB upload are larger than the bundled ones. */
const IDB_SHARD_GET_TIMEOUT_MS = 30_000;
const IDB_PUT_TIMEOUT_MS = 15000;
const IDB_LARGE_PUT_TIMEOUT_MS = 120_000;

export const cacheStats = {
  idbOpenMs: 0,
  idbHits: 0,
  idbMisses: 0,
  idbPuts: 0,
  jsonParses: 0,
  lastSource: '' as string,
};

export function noteJsonParse(label: string): void {
  cacheStats.jsonParses += 1;
  cacheStats.lastSource = `parse:${label}`;
}

export function exposeCacheStats(): void {
  (window as Window & { __docsBrowserCache?: typeof cacheStats }).__docsBrowserCache = cacheStats;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let openStartedAt = 0;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

function openNative(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Blocked means another connection is mid-upgrade — wait for onsuccess, do not fail.
    req.onblocked = () => {};
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PACKAGES_STORE)) {
        db.createObjectStore(PACKAGES_STORE, { keyPath: 'package' });
      }
      if (!db.objectStoreNames.contains(SHARDS_STORE)) {
        const shards = db.createObjectStore(SHARDS_STORE, { keyPath: 'id' });
        shards.createIndex('pkgShard', ['package', 'shard'], { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      cacheStats.idbOpenMs = openStartedAt ? Math.round(performance.now() - openStartedAt) : 0;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** Shared open; callers apply their own wait budget. A timed-out waiter does not cancel open. */
function ensureDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    openStartedAt = performance.now();
    dbPromise = openNative().catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export async function idbGetPackage(name: string): Promise<PackageCache | null> {
  try {
    const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
    const row = await withTimeout(new Promise<PackageCache | null>((resolve, reject) => {
      const tx = db.transaction(PACKAGES_STORE, 'readonly');
      const req = tx.objectStore(PACKAGES_STORE).get(name);
      req.onsuccess = () => resolve((req.result as PackageCache | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
    }), IDB_GET_TIMEOUT_MS);
    if (row) {
      cacheStats.idbHits += 1;
      cacheStats.lastSource = `idb:package:${name}`;
    } else {
      cacheStats.idbMisses += 1;
    }
    return row;
  } catch {
    cacheStats.idbMisses += 1;
    return null;
  }
}

function storageError(err: unknown): Error {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'QuotaExceededError') return new Error('Not enough browser storage to keep this package.');
  if (err instanceof Error && err.message === 'IndexedDB timed out') {
    return new Error('Saving this package took too long.');
  }
  return err instanceof Error ? err : new Error('Saving this package failed.');
}

async function putPackageRow(cache: PackageCache, timeoutMs: number): Promise<void> {
  const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
  await withTimeout(new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PACKAGES_STORE, 'readwrite');
    tx.objectStore(PACKAGES_STORE).put(cache);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
  }), timeoutMs);
  cacheStats.idbPuts += 1;
}

export async function idbPutPackage(cache: PackageCache): Promise<void> {
  try {
    await putPackageRow(cache, IDB_PUT_TIMEOUT_MS);
  } catch {
    // Persistence is best-effort.
  }
}

export async function idbPutPackageStrict(cache: PackageCache): Promise<void> {
  try {
    await putPackageRow(cache, IDB_LARGE_PUT_TIMEOUT_MS);
  } catch (err) {
    throw storageError(err);
  }
}

export async function idbListPackages(): Promise<PackageCache[]> {
  try {
    const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
    return await withTimeout(new Promise<PackageCache[]>((resolve, reject) => {
      const tx = db.transaction(PACKAGES_STORE, 'readonly');
      const req = tx.objectStore(PACKAGES_STORE).getAll();
      req.onsuccess = () => resolve((req.result as PackageCache[] | undefined) ?? []);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB list failed'));
    }), IDB_GET_TIMEOUT_MS);
  } catch {
    return [];
  }
}

export async function idbDeletePackage(name: string): Promise<void> {
  try {
    const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
    await withTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PACKAGES_STORE, 'readwrite');
      tx.objectStore(PACKAGES_STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    }), IDB_PUT_TIMEOUT_MS);
  } catch {
    // Persistence is best-effort.
  }
}

export async function idbGetShard(
  packageName: string,
  shard: string,
  version: string,
): Promise<StoredShard | null> {
  try {
    const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
    const id = shardRecordId(packageName, shard, version);
    const row = await withTimeout(new Promise<StoredShard | null>((resolve, reject) => {
      const tx = db.transaction(SHARDS_STORE, 'readonly');
      const req = tx.objectStore(SHARDS_STORE).get(id);
      req.onsuccess = () => resolve((req.result as StoredShard | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB shard get failed'));
    }), IDB_SHARD_GET_TIMEOUT_MS);
    if (row) {
      cacheStats.idbHits += 1;
      cacheStats.lastSource = `idb:${packageName}:${shard}`;
    } else {
      cacheStats.idbMisses += 1;
    }
    return row;
  } catch {
    cacheStats.idbMisses += 1;
    return null;
  }
}

function putShardRow(row: StoredShard, timeoutMs: number): Promise<void> {
  return withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS).then((db) => withTimeout(new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SHARDS_STORE, 'readwrite');
    const store = tx.objectStore(SHARDS_STORE);
    if (store.indexNames.contains('pkgShard')) {
      const stale = store.index('pkgShard').openCursor([row.package, row.shard]);
      stale.onsuccess = () => {
        const cursor = stale.result;
        if (!cursor) return;
        if (cursor.primaryKey !== row.id) {
          const prev = cursor.value as StoredShard;
          // A user upload must not evict the bundled copy of the same module.
          if (!(prev.bundled && !row.bundled)) cursor.delete();
        }
        cursor.continue();
      };
    }
    store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
  }), timeoutMs)).then(() => {
    cacheStats.idbPuts += 1;
  });
}

export async function idbPutShard(row: StoredShard): Promise<void> {
  try {
    await putShardRow(row, IDB_PUT_TIMEOUT_MS);
  } catch {
    // Persistence is best-effort.
  }
}

export async function idbPutShardStrict(row: StoredShard): Promise<void> {
  try {
    await putShardRow(row, IDB_LARGE_PUT_TIMEOUT_MS);
  } catch (err) {
    throw storageError(err);
  }
}

/** Drop shards written by Ingest package. Bundled catalog shards stay. */
export async function idbDeleteUploadShards(packageName: string): Promise<void> {
  try {
    const db = await withTimeout(ensureDb(), IDB_OPEN_TIMEOUT_MS);
    await withTimeout(new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SHARDS_STORE, 'readwrite');
      const req = tx.objectStore(SHARDS_STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const row = cursor.value as StoredShard;
        if (row.package === packageName && row.bundled === false) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    }), IDB_LARGE_PUT_TIMEOUT_MS);
  } catch {
    // Persistence is best-effort.
  }
}
