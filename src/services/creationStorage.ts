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
}

const STORAGE_KEY = 'yt_markdown_creations_history';
const MAX_LOCAL_CREATIONS = 60;

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
    sizeBytes: new Blob([params.markdownContent]).size,
  };

  let updated: CreationRecord[];
  if (existingIdx >= 0) {
    updated = [newRecord, ...existing.filter((_, idx) => idx !== existingIdx)];
  } else {
    updated = [newRecord, ...existing];
  }

  // Cap to max creations
  if (updated.length > MAX_LOCAL_CREATIONS) {
    updated = updated.slice(0, MAX_LOCAL_CREATIONS);
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Storage limit reached, removing oldest entries:', e);
    try {
      updated = updated.slice(0, 20);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  }

  return newRecord;
}

export function updateCreationDriveInfo(
  identifier: string,
  driveFileId: string,
  driveWebViewLink?: string
): void {
  const existing = getLocalCreations();
  const clean = identifier.trim().toLowerCase().replace(/\.md$/i, '');

  let found = false;
  const updated = existing.map((item) => {
    const itemTitle = item.title.trim().toLowerCase().replace(/\.md$/i, '');
    if (item.id === identifier || itemTitle === clean) {
      found = true;
      return {
        ...item,
        driveFileId,
        driveWebViewLink: driveWebViewLink || item.driveWebViewLink,
        source: 'both' as const,
      };
    }
    return item;
  });

  if (found) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to update creation Drive link:', e);
    }
  }
}

export function deleteLocalCreation(id: string): void {
  const existing = getLocalCreations();
  const updated = existing.filter((item) => item.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to delete local creation:', e);
  }
}
