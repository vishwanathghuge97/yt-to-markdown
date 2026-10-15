import {
  idbSaveCreation,
  idbGetAllCreations,
  idbDeleteCreation,
  idbGetCreation,
} from './storageDb';

export interface CreationRecord {
  id: string;
  title: string;
  channelTitle?: string;
  videoUrl?: string;
  markdownContent: string;
  createdAt: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  source: 'local' | 'drive' | 'both';
  sizeBytes?: number;
  contentStubbed?: boolean;
}

export interface StorageStats {
  usedBytes: number;
  formattedUsed: string;
  itemCount: number;
  estimatedLimitBytes: number;
  percentUsed: number;
  status: 'healthy' | 'moderate' | 'near_limit' | 'quota_exceeded';
}

const STORAGE_KEY = 'yt_markdown_creations_history';
const MAX_LOCAL_CREATIONS_CACHE = 40;
const ESTIMATED_LOCAL_STORAGE_LIMIT = 5 * 1024 * 1024; // ~5MB standard browser limit
// Keep the localStorage cache lightweight: it is only a fast cache for the
// list UI, while full notes live durably in IndexedDB (and Drive). Staying
// well below the browser quota avoids oversized multi-MB writes per save.
const LOCAL_CACHE_BUDGET_BYTES = 2 * 1024 * 1024;
const STUB_MARKER = '\n\n*(Full content preserved in IndexedDB/Drive)*';
const LOCAL_PREVIEW_CHARS = 1500;

/**
 * True when a cached markdown body is only a lightweight preview (the full text
 * lives in IndexedDB/Drive). Handles both the current marker and the legacy
 * Drive-prune marker so old cached stubs still hydrate correctly.
 */
export function isStubbedContent(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return (
    value.includes(STUB_MARKER) ||
    value.includes('Full content preserved in IndexedDB') ||
    value.includes('Full version available in Google Drive')
  );
}

/**
 * Stable merge key for deduplicating records: canonical video URL when known,
 * otherwise the normalized title, otherwise the record id. Used by both the
 * localStorage/IndexedDB hydration merge and backup import.
 */
function creationMatchKey(item: Pick<CreationRecord, 'id' | 'title' | 'videoUrl'>): string {
  const url = (item.videoUrl || '').trim().toLowerCase();
  if (url) return `url:${url}`;
  const title = (item.title || '').trim().toLowerCase().replace(/\.md$/i, '');
  return title ? `title:${title}` : `id:${item.id}`;
}

/**
 * Converts a record into a lightweight cache entry (metadata + short preview).
 * `contentStubbed` lets readers hydrate the full text from IndexedDB/Drive.
 */
function stubLocalContent(item: CreationRecord): CreationRecord {
  if (item.contentStubbed) return item;
  return {
    ...item,
    markdownContent: (item.markdownContent || '').slice(0, LOCAL_PREVIEW_CHARS) + STUB_MARKER,
    contentStubbed: true,
  };
}

/**
 * Gets synchronous creations list from localStorage
 */
export function getLocalCreations(): CreationRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  } catch (err) {
    console.warn('Failed to load local creations history:', err);
    return [];
  }
}

/**
 * Asynchronously loads all creations, merging durable IndexedDB records with
 * the localStorage cache so notes created before the IDB migration are never hidden.
 */
export async function getAllCreationsHydrated(): Promise<CreationRecord[]> {
  const local = getLocalCreations();
  let fromIdb: CreationRecord[] = [];
  try {
    fromIdb = await idbGetAllCreations();
  } catch (e) {
    console.warn('IDB hydration check:', e);
  }

  if (!fromIdb || fromIdb.length === 0) {
    return local;
  }

  // Prefer the canonical video URL as the merge key so two different videos
  // that happen to share a title never collapse into one record.
  const merged = new Map<string, CreationRecord>();
  for (const item of local) {
    merged.set(creationMatchKey(item), item);
  }
  for (const item of fromIdb) {
    const key = creationMatchKey(item);
    const cached = merged.get(key);
    merged.set(key, {
      ...cached,
      ...item, // The IndexedDB copy is authoritative for full content
      driveFileId: item.driveFileId || cached?.driveFileId,
      driveWebViewLink: item.driveWebViewLink || cached?.driveWebViewLink,
    });
  }

  // Repopulate the localStorage cache if it was empty (fresh profile or cleared cache)
  if (local.length === 0) {
    saveToLocalStorageSafe(fromIdb.slice(0, MAX_LOCAL_CREATIONS_CACHE));
  }

  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Writes the creation list to localStorage within a safe size budget.
 * Oversized lists are stored as lightweight previews so the browser quota is
 * never hammered with repeated giant writes; full content stays in IndexedDB.
 */
function saveToLocalStorageSafe(items: CreationRecord[]): boolean {
  if (typeof window === 'undefined') return false;

  let candidate = items.slice(0, MAX_LOCAL_CREATIONS_CACHE);

  // Estimate the UTF-16 footprint BEFORE writing. If the full-fidelity list
  // would exceed the budget, cache previews instead of risking quota errors.
  try {
    if (JSON.stringify(candidate).length * 2 > LOCAL_CACHE_BUDGET_BYTES) {
      candidate = candidate.map(stubLocalContent);
    }
  } catch {
    candidate = candidate.map(stubLocalContent);
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    return true;
  } catch (err) {
    console.warn('localStorage write failed. Falling back to a minimal stub cache:', err);
  }

  // Last-resort fallback: keep only the 10 most recent notes as stub previews.
  try {
    const minimal = candidate.slice(0, 10).map(stubLocalContent);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
    return true;
  } catch (err3) {
    console.error('CRITICAL: LocalStorage completely exhausted. Data is safely stored in IndexedDB.', err3);
    return false;
  }
}

/**
 * Saves a creation record to both localStorage (quick synchronous access)
 * and IndexedDB (unlimited durable storage).
 */
export function saveLocalCreation(params: {
  title: string;
  channelTitle?: string;
  videoUrl?: string;
  markdownContent: string;
  driveFileId?: string;
  driveWebViewLink?: string;
}): CreationRecord {
  const existing = getLocalCreations();
  const cleanTitle = params.title.trim();

  // Match by canonical video URL first (stable per video), then by title as a
  // fallback for legacy records saved before URLs were stored. Different videos
  // that share a title are kept as separate records.
  const cleanUrl = (params.videoUrl || '').trim().toLowerCase();
  const existingIdx = existing.findIndex((item) => {
    if (cleanUrl && item.videoUrl) return item.videoUrl.trim().toLowerCase() === cleanUrl;
    return item.title.toLowerCase() === cleanTitle.toLowerCase();
  });

  const size = new Blob([params.markdownContent]).size;

  const newRecord: CreationRecord = {
    id:
      existingIdx >= 0
        ? existing[existingIdx].id
        : `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: cleanTitle,
    channelTitle: params.channelTitle || existing[existingIdx]?.channelTitle || '',
    videoUrl: params.videoUrl || existing[existingIdx]?.videoUrl || '',
    markdownContent: params.markdownContent,
    createdAt: new Date().toISOString(),
    driveFileId: params.driveFileId || existing[existingIdx]?.driveFileId,
    driveWebViewLink: params.driveWebViewLink || existing[existingIdx]?.driveWebViewLink,
    source: (params.driveFileId || existing[existingIdx]?.driveFileId) ? 'both' : 'local',
    sizeBytes: size,
    contentStubbed: false,
  };

  let updated: CreationRecord[];
  if (existingIdx >= 0) {
    updated = [newRecord, ...existing.filter((_, idx) => idx !== existingIdx)];
  } else {
    updated = [newRecord, ...existing];
  }

  if (updated.length > MAX_LOCAL_CREATIONS_CACHE) {
    updated = updated.slice(0, MAX_LOCAL_CREATIONS_CACHE);
  }

  // 1. Save to localStorage (with safe quota management)
  saveToLocalStorageSafe(updated);

  // 2. Save full pristine copy to IndexedDB (asynchronously, durable, no 5MB limit)
  try {
    idbSaveCreation(newRecord).catch((e) => console.warn('IDB async save notice:', e));
  } catch (e) {
    console.warn('IDB trigger failed:', e);
  }

  return newRecord;
}

/**
 * Retrieves the full markdown content of a creation, fetching from IndexedDB
 * if the localStorage version was stubbed due to quota limits. Returns null
 * (instead of a truncated preview) when no durable copy exists, so callers can
 * fall back to Google Drive.
 */
export async function getFullCreationContent(id: string): Promise<string | null> {
  // Check local storage first
  const localList = getLocalCreations();
  const found = localList.find((item) => item.id === id);
  if (found && !found.contentStubbed && !isStubbedContent(found.markdownContent) && found.markdownContent) {
    return found.markdownContent;
  }

  // Fallback to IndexedDB
  try {
    const idbItem = await idbGetCreation(id);
    if (idbItem && idbItem.markdownContent && !isStubbedContent(idbItem.markdownContent)) {
      return idbItem.markdownContent;
    }
  } catch (e) {
    console.warn('Error reading from IDB:', e);
  }

  // No durable copy: signal the caller so it can try Drive instead of showing a preview.
  return null;
}

/**
 * Normalizes a creation title or exported file name for Drive linkage matching.
 * Strips the markdown extension and the app's "-summary" export suffix.
 * Exported so the history drawer can merge Drive files with local notes identically.
 */
export function normalizeTitleForMatch(value: string): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[-_\s]+summary$/i, '')
    .trim();
}

/**
 * Updates an existing creation with Google Drive sync metadata
 */
export function updateCreationDriveInfo(
  identifier: string,
  driveFileId: string,
  driveWebViewLink?: string
): void {
  const existing = getLocalCreations();
  const cleanTitle = normalizeTitleForMatch(identifier);

  let bestIdx = -1;
  let bestScore = 0;
  existing.forEach((item, idx) => {
    if (item.id === identifier) {
      if (bestScore < 3) {
        bestIdx = idx;
        bestScore = 3;
      }
      return;
    }
    const itemTitle = normalizeTitleForMatch(item.title);
    if (!itemTitle || !cleanTitle) return;
    if (itemTitle === cleanTitle) {
      if (bestScore < 2) {
        bestIdx = idx;
        bestScore = 2;
      }
      return;
    }
    // Exported file names can be truncated versions of the note title
    // (e.g. "<title cut at 40 chars>-summary.md"), so allow prefix matches.
    const shorter = itemTitle.length <= cleanTitle.length ? itemTitle : cleanTitle;
    const longer = itemTitle.length <= cleanTitle.length ? cleanTitle : itemTitle;
    if (shorter.length >= 12 && longer.startsWith(shorter) && bestScore < 1) {
      bestIdx = idx;
      bestScore = 1;
    }
  });

  if (bestIdx < 0) return;

  const target = existing[bestIdx];
  const updatedItem: CreationRecord = {
    ...target,
    driveFileId,
    driveWebViewLink: driveWebViewLink || target.driveWebViewLink,
    source: 'both' as const,
  };

  const updated = existing.map((item, idx) => (idx === bestIdx ? updatedItem : item));
  saveToLocalStorageSafe(updated);

  try {
    if (target.contentStubbed) {
      // Merge the Drive metadata into the durable copy instead of replacing
      // full IndexedDB content with a quota-stubbed cache entry.
      idbGetCreation(target.id)
        .then((durable) =>
          idbSaveCreation(
            durable
              ? {
                  ...durable,
                  driveFileId,
                  driveWebViewLink: driveWebViewLink || durable.driveWebViewLink,
                  source: 'both' as const,
                }
              : updatedItem
          )
        )
        .catch(() => {});
    } else {
      idbSaveCreation(updatedItem).catch(() => {});
    }
  } catch {}
}

/**
 * Deletes a creation from both localStorage and IndexedDB
 */
export function deleteLocalCreation(id: string): void {
  const existing = getLocalCreations();
  const updated = existing.filter((item) => item.id !== id);
  saveToLocalStorageSafe(updated);

  try {
    idbDeleteCreation(id).catch(() => {});
  } catch (e) {
    console.warn('Failed to delete from IDB:', e);
  }
}

/**
 * Calculates current storage usage stats and health indicators
 */
export function getStorageStats(): StorageStats {
  if (typeof window === 'undefined') {
    return {
      usedBytes: 0,
      formattedUsed: '0 KB',
      itemCount: 0,
      estimatedLimitBytes: ESTIMATED_LOCAL_STORAGE_LIMIT,
      percentUsed: 0,
      status: 'healthy',
    };
  }

  let totalChars = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const val = localStorage.getItem(key) || '';
        totalChars += key.length + val.length;
      }
    }
  } catch {}

  // UTF-16 characters take roughly 2 bytes
  const usedBytes = totalChars * 2;
  const items = getLocalCreations();
  const percentUsed = Math.min(100, Math.round((usedBytes / ESTIMATED_LOCAL_STORAGE_LIMIT) * 100));

  let status: StorageStats['status'] = 'healthy';
  if (percentUsed >= 95) {
    status = 'quota_exceeded';
  } else if (percentUsed >= 75) {
    status = 'near_limit';
  } else if (percentUsed >= 45) {
    status = 'moderate';
  }

  const formattedUsed =
    usedBytes > 1024 * 1024
      ? `${(usedBytes / (1024 * 1024)).toFixed(2)} MB`
      : `${Math.round(usedBytes / 1024)} KB`;

  return {
    usedBytes,
    formattedUsed,
    itemCount: items.length,
    estimatedLimitBytes: ESTIMATED_LOCAL_STORAGE_LIMIT,
    percentUsed,
    status,
  };
}

/**
 * Frees up local storage by removing the markdown bodies of creations that are already
 * backed up to Google Drive (keeping metadata so the user still has them in the list).
 */
export function pruneSyncedCreations(): { freedCount: number } {
  const items = getLocalCreations();
  let freedCount = 0;

  const optimized = items.map((item) => {
    if (item.driveFileId && item.markdownContent && !item.contentStubbed) {
      freedCount++;
      return stubLocalContent(item);
    }
    return item;
  });

  if (freedCount > 0) {
    saveToLocalStorageSafe(optimized);
  }

  return { freedCount };
}

/**
 * Exports all local and IndexedDB creations as a single JSON backup file
 */
export async function exportCreationsBackup(): Promise<string> {
  const hydrated = await getAllCreationsHydrated();
  const backupData = {
    app: 'yt-to-markdown',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    creationsCount: hydrated.length,
    creations: hydrated,
  };
  return JSON.stringify(backupData, null, 2);
}

/**
 * Imports creations from a JSON backup file (allows seamless migration across local/prod)
 */
export async function importCreationsBackup(
  jsonString: string
): Promise<{ importedCount: number; message: string }> {
  try {
    const data = JSON.parse(jsonString);
    const list: CreationRecord[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.creations)
      ? data.creations
      : [];

    if (list.length === 0) {
      return { importedCount: 0, message: 'No valid creation records found in file.' };
    }

    let count = 0;
    const current = getLocalCreations();
    const indexByKey = new Map(current.map((c, idx) => [creationMatchKey(c), idx]));

    const merged = [...current];

    for (const item of list) {
      if (!item.title || !item.markdownContent) continue;
      const key = creationMatchKey(item);
      const existingIdx = indexByKey.get(key);

      if (existingIdx === undefined) {
        const record: CreationRecord = {
          id: item.id || `imported_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: item.title,
          channelTitle: item.channelTitle || '',
          videoUrl: item.videoUrl || '',
          markdownContent: item.markdownContent,
          createdAt: item.createdAt || new Date().toISOString(),
          driveFileId: item.driveFileId,
          driveWebViewLink: item.driveWebViewLink,
          source: item.driveFileId ? 'both' : 'local',
          sizeBytes: item.sizeBytes || new Blob([item.markdownContent]).size,
          contentStubbed: false,
        };

        merged.push(record);
        indexByKey.set(key, merged.length - 1);
        count++;

        // Also save to IndexedDB
        try {
          await idbSaveCreation(record);
        } catch {}
        continue;
      }

      // Key already exists: normally a duplicate, but if the cached copy is
      // only a stub (trimmed to keep localStorage light), restore full content.
      const existing = merged[existingIdx];
      const incomingIsStub = item.contentStubbed === true || isStubbedContent(item.markdownContent);
      if (existing?.contentStubbed && !incomingIsStub) {
        const restored: CreationRecord = {
          ...existing,
          markdownContent: item.markdownContent,
          contentStubbed: false,
          sizeBytes: item.sizeBytes || new Blob([item.markdownContent]).size,
          driveFileId: existing.driveFileId || item.driveFileId,
          driveWebViewLink: existing.driveWebViewLink || item.driveWebViewLink,
        };
        merged[existingIdx] = restored;
        count++;
        try {
          await idbSaveCreation(restored);
        } catch {}
      }
    }

    saveToLocalStorageSafe(merged);
    return {
      importedCount: count,
      message: `Successfully imported ${count} ${count === 1 ? 'creation' : 'creations'}!`,
    };
  } catch (err: any) {
    throw new Error(`Invalid JSON backup file: ${err.message}`);
  }
}
