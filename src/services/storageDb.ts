/**
 * IndexedDB storage engine for YouTube Markdown creations.
 * Unlike localStorage (capped at ~5MB), IndexedDB provides hundreds of MBs of storage,
 * ensuring users never lose notes even with hundreds of large video transcripts.
 */

import type { CreationRecord } from './creationStorage';

const DB_NAME = 'yt_markdown_db';
const DB_VERSION = 1;
const STORE_NAME = 'creations';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported in this environment'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
  });
}

/**
 * Runs a single-store IndexedDB transaction and always closes the connection,
 * including on request errors and aborts (which previously leaked connections).
 * Rejections propagate so callers can tell a failed durable write from success.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      let requestResult: T;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      try {
        const tx = db.transaction(STORE_NAME, mode);
        const request = run(tx.objectStore(STORE_NAME));

        request.onsuccess = () => {
          requestResult = request.result;
        };
        request.onerror = () =>
          settle(() => reject(request.error || new Error('IndexedDB request failed')));
        tx.oncomplete = () => settle(() => resolve(requestResult));
        tx.onerror = () => settle(() => reject(tx.error || new Error('IndexedDB transaction failed')));
        tx.onabort = () => settle(() => reject(tx.error || new Error('IndexedDB transaction aborted')));
      } catch (err) {
        settle(() => reject(err));
      }
    });
  } finally {
    db.close();
  }
}

/**
 * Saves or updates a creation record in IndexedDB
 */
export async function idbSaveCreation(record: CreationRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(record));
}

/**
 * Loads all creation records from IndexedDB, newest first
 */
export async function idbGetAllCreations(): Promise<CreationRecord[]> {
  const results = await withStore<CreationRecord[]>('readonly', (store) => store.getAll());
  return (results || []).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Gets a specific creation by ID from IndexedDB
 */
export async function idbGetCreation(id: string): Promise<CreationRecord | null> {
  const result = await withStore<CreationRecord | undefined>('readonly', (store) => store.get(id));
  return result || null;
}

/**
 * Deletes a creation record from IndexedDB
 */
export async function idbDeleteCreation(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}
