import {
  idbSaveCreation,
  idbGetAllCreations,
  idbDeleteCreation,
  idbGetCreation,
  idbClearAllCreations,
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
 * Asynchronously loads all creations, hydrating from IndexedDB if needed
 */
export async function getAllCreationsHydrated(): Promise<CreationRecord[]> {
  try {
    const fromIdb = await idbGetAllCreations();
    if (fromIdb && fromIdb.length > 0) {
      // Sync IDB creations to local storage cache if localStorage is empty
      const local = getLocalCreations();
      if (local.length === 0) {
        saveToLocalStorageSafe(fromIdb.slice(0, MAX_LOCAL_CREATIONS_CACHE));
      }
      return fromIdb;
    }
  } catch (e) {
    console.warn('IDB hydration check:', e);
  }
  return getLocalCreations();
}

/**
 * Safely writes to localStorage with automatic quota management and LRU eviction.
 * If quota is reached, trims markdownContent from older items while preserving them in IndexedDB.
 */
function saveToLocalStorageSafe(items: CreationRecord[]): boolean {
  if (typeof window === 'undefined') return false;

  let candidate = [...items];

  // Try direct write first
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    return true;
  } catch (err) {
    console.warn('localStorage quota reached or write error. Initiating graceful eviction:', err);
  }

  // Strategy 1: Keep top 20 items with full content, stub markdownContent on remaining items
  try {
    candidate = candidate.map((item, idx) => {
      if (idx >= 15 && item.markdownContent && item.markdownContent.length > 200) {
        return {
          ...item,
          markdownContent: item.markdownContent.slice(0, 200) + '\n\n*(Full content preserved in IndexedDB/Drive)*',
          contentStubbed: true,
        };
      }
      return item;
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate.slice(0, 25)));
    return true;
  } catch (err2) {
    console.warn('Strategy 1 failed, trying minimal stub cache:', err2);
  }

  // Strategy 2: Keep only top 10 recent items as stubs
  try {
    const minimal = candidate.slice(0, 10).map((item) => ({
      ...item,
      markdownContent: item.markdownContent.slice(0, 150),
      contentStubbed: true,
    }));
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

  // Check if an existing creation matches by exact title to update it instead of creating duplicates
  const existingIdx = existing.findIndex(
    (item) => item.title.toLowerCase() === cleanTitle.toLowerCase()
  );

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
 * if the localStorage version was stubbed due to quota limits.
 */
export async function getFullCreationContent(id: string): Promise<string | null> {
  // Check local storage first
  const localList = getLocalCreations();
  const found = localList.find((item) => item.id === id);
  if (found && !found.contentStubbed && found.markdownContent) {
    return found.markdownContent;
  }

  // Fallback to IndexedDB
  try {
    const idbItem = await idbGetCreation(id);
    if (idbItem && idbItem.markdownContent) {
      return idbItem.markdownContent;
    }
  } catch (e) {
    console.warn('Error reading from IDB:', e);
  }

  return found?.markdownContent || null;
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
  const clean = identifier.trim().toLowerCase().replace(/\.md$/i, '');

  let foundItem: CreationRecord | null = null;
  const updated = existing.map((item) => {
    const itemTitle = item.title.trim().toLowerCase().replace(/\.md$/i, '');
    if (item.id === identifier || itemTitle === clean) {
      const updatedItem: CreationRecord = {
        ...item,
        driveFileId,
        driveWebViewLink: driveWebViewLink || item.driveWebViewLink,
        source: 'both' as const,
      };
      foundItem = updatedItem;
      return updatedItem;
    }
    return item;
  });

  if (foundItem) {
    saveToLocalStorageSafe(updated);
    try {
      idbSaveCreation(foundItem).catch(() => {});
    } catch {}
  }
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
      return {
        ...item,
        markdownContent: item.markdownContent.slice(0, 150) + '\n\n*(Full version available in Google Drive)*',
        contentStubbed: true,
      };
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
    const existingTitles = new Set(current.map((c) => c.title.toLowerCase().trim()));

    const merged = [...current];

    for (const item of list) {
      if (!item.title || !item.markdownContent) continue;
      const cleanTitle = item.title.toLowerCase().trim();

      if (!existingTitles.has(cleanTitle)) {
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
        existingTitles.add(cleanTitle);
        count++;

        // Also save to IndexedDB
        try {
          await idbSaveCreation(record);
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
