import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { User } from 'firebase/auth';
import {
  DriveUploadResult,
  listRecentDriveExports,
  fetchDriveFileContent,
  deleteDriveFile,
  saveMarkdownToDrive,
  isAuthRequiredError,
} from '../services/googleDrive';
import { googleSignIn, formatAuthError, auth } from '../services/firebase';
import {
  getLocalCreations,
  deleteLocalCreation,
  updateCreationDriveInfo,
  CreationRecord,
  getStorageStats,
  getFullCreationContent,
  exportCreationsBackup,
  importCreationsBackup,
  pruneSyncedCreations,
  StorageStats,
  getAllCreationsHydrated,
  isStubbedContent,
  normalizeTitleForMatch,
} from '../services/creationStorage';
import { copyTextToClipboard } from '../utils/clipboard';
import { downloadTextFile } from '../utils/download';
import {
  Clock,
  Search,
  RefreshCw,
  Eye,
  Copy,
  Check,
  Download,
  Trash2,
  ExternalLink,
  HardDrive,
  FileText,
  Loader2,
  Cloud,
  Laptop,
  AlertCircle,
  Upload,
  Database,
  FileUp,
  FileDown,
  Sparkles,
} from 'lucide-react';

export interface UnifiedCreation {
  id: string;
  title: string;
  channelTitle?: string;
  videoUrl?: string;
  createdAt: string;
  markdownContent?: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  sizeBytes?: number;
  source: 'local' | 'drive' | 'both';
}

interface PreviousCreationsProps {
  user: User | null;
  onAuthChange: (user: User | null) => void;
  onSelectCreation: (title: string, markdownContent: string) => void;
  lastGeneratedTime?: number;
  /** Effective Drive availability for this device (see shared/features.ts). */
  driveEnabled: boolean;
}

/**
 * Resolves the full markdown for a history item: in-memory/localStorage copy
 * first, then IndexedDB, and finally Google Drive when only a stub exists and
 * the Drive feature is available. Returns null when no source has the content.
 */
async function resolveFullContent(
  item: UnifiedCreation,
  driveEnabled: boolean
): Promise<string | null> {
  if (item.markdownContent && !isStubbedContent(item.markdownContent)) {
    return item.markdownContent;
  }

  try {
    const local = await getFullCreationContent(item.id);
    if (local) return local;
  } catch (err) {
    console.warn('Local content lookup failed:', err);
  }

  if (driveEnabled && item.driveFileId) {
    try {
      return await fetchDriveFileContent(item.driveFileId);
    } catch (err) {
      console.warn('Drive content fetch failed:', err);
    }
  }

  return null;
}

export const PreviousCreations: React.FC<PreviousCreationsProps> = ({
  user,
  onAuthChange,
  onSelectCreation,
  lastGeneratedTime,
  driveEnabled,
}) => {
  const [localCreations, setLocalCreations] = useState<CreationRecord[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveUploadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'drive' | 'local'>('all');
  const [actionFileId, setActionFileId] = useState<string | null>(null);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [savingToDriveId, setSavingToDriveId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats>(getStorageStats);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic id for Drive loads so an older response never overwrites a newer one.
  const driveLoadIdRef = useRef(0);
  // Single shared notice timer: a new notice replaces (not races) the old one.
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, durationMs = 3000) => {
    setStatusNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setStatusNotice(null);
      noticeTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // Reload local creations on mount and whenever lastGeneratedTime updates
  const reloadLocalCreations = useCallback(() => {
    const records = getLocalCreations();
    setLocalCreations(records);
    setStorageStats(getStorageStats());
  }, []);

  useEffect(() => {
    reloadLocalCreations();
    let isMounted = true;
    getAllCreationsHydrated().then((hydrated) => {
      if (isMounted && hydrated && hydrated.length > 0) {
        setLocalCreations(hydrated);
        setStorageStats(getStorageStats());
      }
    });
    return () => {
      isMounted = false;
    };
  }, [reloadLocalCreations, lastGeneratedTime]);

  // Load Google Drive files. Reads the live Firebase session (not the `user`
  // prop) so a sync started right after sign-in sees the fresh currentUser.
  const loadDriveFiles = useCallback(
    async (isManual = false) => {
      if (!auth?.currentUser) {
        setDriveFiles([]);
        return;
      }

      const requestId = ++driveLoadIdRef.current;
      try {
        setIsLoading(true);
        setIsSyncing(true);
        setAuthErrorMessage(null);
        if (isManual) {
          setStatusNotice('Syncing with Google Drive...');
        }

        const list = await listRecentDriveExports();
        if (driveLoadIdRef.current !== requestId) return; // superseded by a newer load
        setDriveFiles(list);
        setNeedsReauth(false);

        if (isManual) {
          showNotice(`✓ Synced (${list.length} Drive ${list.length === 1 ? 'file' : 'files'})`);
        }
      } catch (err: any) {
        if (driveLoadIdRef.current !== requestId) return;
        if (isAuthRequiredError(err)) {
          // The Firebase session is still active but the Google access token
          // expired; surface an explicit reconnect action (needs a user click).
          setNeedsReauth(true);
          setStatusNotice('Google Drive access expired. Use "Reconnect Drive" to continue syncing.');
        } else {
          setAuthErrorMessage(formatAuthError(err));
          showNotice('Could not reach Google Drive.', 4000);
        }
      } finally {
        if (driveLoadIdRef.current === requestId) {
          setIsLoading(false);
          setIsSyncing(false);
        }
      }
    },
    [showNotice]
  );

  useEffect(() => {
    // Drive off: nothing to sync, no auth state to reflect.
    if (!driveEnabled) {
      setDriveFiles([]);
      setNeedsReauth(false);
      return;
    }
    if (user) {
      loadDriveFiles(false);
    } else {
      setDriveFiles([]);
      setNeedsReauth(false);
    }
  }, [user, driveEnabled, loadDriveFiles]);

  const handleConnectDrive = async () => {
    try {
      setIsLoading(true);
      setAuthErrorMessage(null);
      setStatusNotice(null);
      const res = await googleSignIn();
      if (res?.user) {
        onAuthChange(res.user);
        await loadDriveFiles(true);
      }
    } catch (err: any) {
      const formatted = formatAuthError(err);
      setAuthErrorMessage(formatted);
    } finally {
      setIsLoading(false);
    }
  };

  // Merge Local creations and Google Drive exports
  const unifiedCreations = useMemo<UnifiedCreation[]>(() => {
    const map = new Map<string, UnifiedCreation>();

    // 1. Add all local creations. normalizeTitleForMatch strips ".md" and the
    // export "-summary" suffix so a note and its Drive copy merge as one row.
    for (const item of localCreations) {
      const normalizedTitle = normalizeTitleForMatch(item.title) || item.id;
      map.set(normalizedTitle, {
        id: item.id,
        title: item.title,
        channelTitle: item.channelTitle,
        videoUrl: item.videoUrl,
        createdAt: item.createdAt,
        markdownContent: item.markdownContent,
        driveFileId: item.driveFileId,
        driveWebViewLink: item.driveWebViewLink,
        sizeBytes: item.sizeBytes,
        source: item.driveFileId ? 'both' : 'local',
      });
    }

    // 2. Merge or add Drive files
    for (const driveFile of driveFiles) {
      const cleanName = driveFile.name.trim().replace(/\.md$/i, '');
      const normalizedTitle = normalizeTitleForMatch(driveFile.name) || cleanName.toLowerCase();

      if (map.has(normalizedTitle)) {
        const existing = map.get(normalizedTitle)!;
        map.set(normalizedTitle, {
          ...existing,
          driveFileId: driveFile.id,
          driveWebViewLink: driveFile.webViewLink,
          source: 'both',
        });
      } else {
        // Exists in Drive but not in local storage on this machine
        map.set(normalizedTitle, {
          id: driveFile.id,
          title: cleanName,
          createdAt: driveFile.createdTime || new Date().toISOString(),
          driveFileId: driveFile.id,
          driveWebViewLink: driveFile.webViewLink,
          sizeBytes: driveFile.size ? parseInt(driveFile.size, 10) : undefined,
          source: 'drive',
        });
      }
    }

    // Sort descending by creation date (invalid dates fall to the end)
    const timeOf = (value: string) => {
      const t = new Date(value).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    return Array.from(map.values()).sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  }, [localCreations, driveFiles]);

  const filteredCreations = useMemo(() => {
    let list = unifiedCreations;

    if (activeTab === 'drive') {
      list = list.filter((c) => c.source === 'drive' || c.source === 'both');
    } else if (activeTab === 'local') {
      list = list.filter((c) => c.source === 'local');
    }

    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.channelTitle && c.channelTitle.toLowerCase().includes(q))
    );
  }, [unifiedCreations, activeTab, searchQuery]);

  // Load content (either from local, IndexedDB, or Drive) and select it for viewing
  const handleView = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      const needsDriveFetch =
        (!item.markdownContent || isStubbedContent(item.markdownContent)) && !!item.driveFileId;
      if (needsDriveFetch) {
        setStatusNotice('Fetching from Google Drive...');
      }

      const content = await resolveFullContent(item, driveEnabled);
      if (content) {
        setStatusNotice(null);
        onSelectCreation(item.title, content);
        // Smoothness comes from the global CSS scroll-behavior rule
        // (which respects prefers-reduced-motion).
        window.scrollTo({ top: 0 });
      } else {
        showNotice('No content available for this note.');
      }
    } catch (err) {
      console.warn('View note failed:', err);
      showNotice('Failed to load note content.');
    } finally {
      setActionFileId(null);
    }
  };

  const handleCopy = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      const content = await resolveFullContent(item, driveEnabled);
      if (!content) throw new Error('No content');

      const copied = await copyTextToClipboard(content);
      if (!copied) throw new Error('Clipboard unavailable');

      setCopiedFileId(item.id);
      setTimeout(() => setCopiedFileId(null), 2000);
    } catch (err) {
      console.warn('Copy note failed:', err);
      showNotice('Failed to copy note.');
    } finally {
      setActionFileId(null);
    }
  };

  const handleDownload = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      const content = await resolveFullContent(item, driveEnabled);
      if (!content) throw new Error('No content');

      downloadTextFile(
        item.title.endsWith('.md') ? item.title : `${item.title}.md`,
        content
      );
    } catch (err) {
      console.warn('Download note failed:', err);
      showNotice('Failed to download note.');
    } finally {
      setActionFileId(null);
    }
  };

  // Push a local creation to Google Drive
  const handleSaveToDrive = async (item: UnifiedCreation) => {
    try {
      setSavingToDriveId(item.id);
      setStatusNotice('Uploading note to Google Drive...');

      const contentToSave = await resolveFullContent(item, driveEnabled);
      if (!contentToSave) {
        throw new Error('No note content found to save.');
      }

      const result = await saveMarkdownToDrive(
        item.title,
        contentToSave,
        `Exported summary for ${item.title}`
      );
      updateCreationDriveInfo(item.id, result.id, result.webViewLink);
      reloadLocalCreations();
      await loadDriveFiles(false);
      showNotice('✓ Saved to Google Drive!');
    } catch (err: any) {
      const formatted = formatAuthError(err);
      setAuthErrorMessage(formatted);
      showNotice('Failed to save to Google Drive.', 4000);
    } finally {
      setSavingToDriveId(null);
    }
  };

  const handleExportBackup = async () => {
    try {
      const json = await exportCreationsBackup();
      downloadTextFile(
        `yt-creations-backup-${new Date().toISOString().slice(0, 10)}.json`,
        json,
        'application/json;charset=utf-8'
      );
      showNotice('✓ Backup JSON exported successfully.', 3500);
    } catch {
      showNotice('Failed to export backup.', 3500);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await importCreationsBackup(text);
      showNotice(`✓ ${res.message}`, 4000);
      reloadLocalCreations();
    } catch (err: any) {
      showNotice(`Import error: ${err?.message || 'invalid backup file'}`, 4000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePruneSynced = () => {
    const { freedCount } = pruneSyncedCreations();
    if (freedCount > 0) {
      showNotice(
        `✓ Cleaned local storage cache for ${freedCount} Drive-backed ${freedCount === 1 ? 'note' : 'notes'}.`,
        3500
      );
      reloadLocalCreations();
    } else {
      showNotice('No Drive-synced notes required local cache cleanup.', 3500);
    }
  };

  const handleDelete = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      // Remove from local storage
      deleteLocalCreation(item.id);
      reloadLocalCreations();

      // If it exists in Drive and Drive is connected, delete from Drive too.
      // A Drive failure is reported explicitly instead of silently claiming success.
      let driveDeleteFailed = false;
      if (driveEnabled && item.driveFileId && user) {
        try {
          await deleteDriveFile(item.driveFileId);
          setDriveFiles((prev) => prev.filter((f) => f.id !== item.driveFileId));
        } catch (e) {
          console.warn('Could not delete from Drive:', e);
          driveDeleteFailed = true;
        }
      }

      setConfirmDeleteId(null);
      if (driveDeleteFailed) {
        showNotice('Note removed locally, but deleting it from Google Drive failed. Try again later.', 5000);
      } else {
        showNotice('Note deleted.');
      }
    } catch (err) {
      console.warn('Delete note failed:', err);
      showNotice('Failed to delete note.');
    } finally {
      setActionFileId(null);
    }
  };

  const formatDate = (isoString?: string) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  };

  const formatSize = (bytes?: number) => {
    if (!bytes || isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  const driveCount = unifiedCreations.filter(
    (c) => c.source === 'drive' || c.source === 'both'
  ).length;
  const localOnlyCount = unifiedCreations.filter((c) => c.source === 'local').length;

  return (
    <section
      id="previous-creations"
      className="card p-4 sm:p-5 shadow-xs transition-colors duration-150 space-y-4"
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-100 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Previous Creations
              </h2>
              {unifiedCreations.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {unifiedCreations.length}
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
              {driveEnabled
                ? 'Persistent storage in browser and synchronized with Google Drive'
                : 'Persistent storage in your browser'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {statusNotice && (
            <span role="status" className="text-xs font-mono text-zinc-500 dark:text-zinc-400 anim-fade-in">
              {statusNotice}
            </span>
          )}

          {driveEnabled && (user ? (
            needsReauth ? (
              <button
                type="button"
                onClick={handleConnectDrive}
                disabled={isLoading}
                className="btn px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-xs bg-amber-50 dark:bg-amber-950/50 hover:bg-amber-100 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                aria-label="Reconnect Google Drive"
              >
                <HardDrive className="w-3.5 h-3.5" />
                <span>{isLoading ? 'Reconnecting...' : 'Reconnect Drive'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => loadDriveFiles(true)}
                disabled={isSyncing}
                className={`btn px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-xs border border-zinc-300 dark:border-zinc-700 ${
                  isSyncing
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'
                    : 'bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                }`}
                aria-label="Sync creations from Google Drive"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 transition-transform ${
                    isSyncing ? 'animate-spin text-blue-500' : ''
                  }`}
                />
                <span>{isSyncing ? 'Syncing...' : 'Sync Drive'}</span>
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={handleConnectDrive}
              disabled={isLoading}
              className="btn px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-xs bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/70"
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Connect Drive</span>
            </button>
          ))}
        </div>
      </div>

      {/* Production / Vercel Domain Notice Banner if auth failed (Drive only) */}
      {driveEnabled && authErrorMessage && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-semibold">{authErrorMessage}</p>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Note: Your local creations remain completely safe and accessible below even if Google Drive authorization is pending.
            </p>
          </div>
        </div>
      )}

      {/* Tabs & Search */}
      {unifiedCreations.length > 0 && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-1">
          {/* Tabs (the Drive filter exists only while the Drive feature is on) */}
          {driveEnabled && (
          <div className="inline-flex flex-wrap rounded-lg bg-zinc-100 dark:bg-zinc-800/80 p-1 text-xs sm:text-[13px] font-mono">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              aria-pressed={activeTab === 'all'}
              className={`px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] whitespace-nowrap rounded-md transition ${
                activeTab === 'all'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              All ({unifiedCreations.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('drive')}
              aria-pressed={activeTab === 'drive'}
              className={`px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] whitespace-nowrap rounded-md transition flex items-center gap-1 ${
                activeTab === 'drive'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Cloud className="w-3 h-3 text-blue-500" />
              <span>In Drive ({driveCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('local')}
              aria-pressed={activeTab === 'local'}
              className={`px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] whitespace-nowrap rounded-md transition flex items-center gap-1 ${
                activeTab === 'local'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Laptop className="w-3 h-3 text-zinc-500" />
              <span>Local ({localOnlyCount})</span>
            </button>
          </div>
          )}

          {/* Search box */}
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search creations..."
              aria-label="Search creations"
              className="input pl-8 pr-3 py-2 sm:py-1.5 min-h-[40px] sm:min-h-[32px] bg-zinc-50 dark:bg-zinc-950 font-mono text-base sm:text-[13px]"
            />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {unifiedCreations.length === 0 ? (
        <div className="py-10 px-4 text-center space-y-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/40">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto">
            <FileText className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              No saved creations yet
            </h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto leading-relaxed">
              When you generate notes for any YouTube video above, they will automatically be preserved
              here{driveEnabled ? ' and can be exported directly to your Google Drive.' : '.'}
            </p>
          </div>
          {driveEnabled && !user && (
            <button
              type="button"
              onClick={handleConnectDrive}
              disabled={isLoading}
              className="btn btn-primary px-3.5 py-2 min-h-[44px] sm:min-h-[40px] text-xs"
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Connect Drive for Cloud Backup</span>
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Cards Grid */}
          <div
            className={`grid grid-cols-1 sm:grid-cols-2 gap-2.5 transition-opacity duration-200 ${
              isSyncing ? 'opacity-70' : 'opacity-100'
            }`}
          >
            {filteredCreations.map((item) => {
              const isBusy = actionFileId === item.id;
              const isCopied = copiedFileId === item.id;
              const isSavingDrive = savingToDriveId === item.id;
              const isConfirmingDelete = confirmDeleteId === item.id;
              const dateStr = formatDate(item.createdAt);
              const sizeStr = formatSize(item.sizeBytes);

              return (
                <div
                  key={item.id}
                  className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/60 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all duration-150 flex flex-col justify-between gap-2.5"
                >
                  {/* Top info */}
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4
                        className="text-sm font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1"
                        title={item.title}
                      >
                        {item.title}
                      </h4>

                      {/* Source badges */}
                      <div className="flex items-center gap-1 shrink-0">
                        {item.driveWebViewLink ? (
                          <a
                            href={item.driveWebViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 hover:bg-blue-100 transition"
                            title="Open file directly in Google Drive"
                          >
                            <Cloud className="w-2.5 h-2.5" />
                            <span>Drive</span>
                            <ExternalLink className="w-2.5 h-2.5 ml-0.5" />
                          </a>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700"
                            title="Stored in browser local storage"
                          >
                            <Laptop className="w-2.5 h-2.5" />
                            <span>Local</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-400 mt-1">
                      {item.channelTitle && (
                        <>
                          <span className="truncate max-w-[120px] text-zinc-500 dark:text-zinc-400">
                            {item.channelTitle}
                          </span>
                          <span>·</span>
                        </>
                      )}
                      {dateStr && <span>{dateStr}</span>}
                      {dateStr && sizeStr && <span>·</span>}
                      {sizeStr && <span>{sizeStr}</span>}
                    </div>
                  </div>

                  {/* Actions */}
                  {isConfirmingDelete ? (
                    <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80 text-xs font-mono">
                      <span className="text-rose-600 dark:text-rose-400 font-medium">
                        Delete note?
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="btn px-2.5 py-1 min-h-[40px] sm:min-h-[32px] text-xs border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item)}
                          disabled={isBusy}
                          className="btn px-2.5 py-1 min-h-[40px] sm:min-h-[32px] text-xs bg-rose-600 hover:bg-rose-700 text-white font-medium"
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleView(item)}
                          disabled={isBusy}
                          className="btn btn-primary px-2.5 py-1 min-h-[40px] sm:min-h-[32px] text-xs"
                        >
                          {isBusy && actionFileId === item.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                          <span>View</span>
                        </button>

                        {/* If note is local only, show quick Save to Drive button */}
                        {driveEnabled && !item.driveFileId && item.markdownContent && user && (
                          <button
                            type="button"
                            onClick={() => handleSaveToDrive(item)}
                            disabled={isSavingDrive}
                            className="btn px-2 py-1 min-h-[40px] sm:min-h-[32px] text-xs bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/70"
                            title="Save copy to Google Drive"
                          >
                            {isSavingDrive ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Upload className="w-3 h-3" />
                            )}
                            <span>Save to Drive</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleCopy(item)}
                          disabled={isBusy}
                          className="btn btn-ghost p-2 min-h-[40px] min-w-[40px] sm:min-h-[32px] sm:min-w-[32px]"
                          aria-label="Copy markdown"
                          title="Copy markdown text"
                        >
                          {isCopied ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownload(item)}
                          disabled={isBusy}
                          className="btn btn-ghost p-2 min-h-[40px] min-w-[40px] sm:min-h-[32px] sm:min-w-[32px]"
                          aria-label="Download markdown"
                          title="Download .md file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          disabled={isBusy}
                          className="btn btn-danger p-2 min-h-[40px] min-w-[40px] sm:min-h-[32px] sm:min-w-[32px]"
                          aria-label="Delete note"
                          title="Delete note"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Storage Management Footer & Data Portability Bar */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportFile}
        accept=".json,application/json"
        className="hidden"
      />

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/80 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs font-mono text-zinc-500 dark:text-zinc-400">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
            <Database className="w-3.5 h-3.5 text-zinc-500" />
            <span>Storage: {storageStats.formattedUsed}</span>
            <span className="text-zinc-400 dark:text-zinc-500">({storageStats.itemCount} {storageStats.itemCount === 1 ? 'note' : 'notes'})</span>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>IndexedDB Durable Engine: Active</span>
          </div>

          {storageStats.status === 'near_limit' && (
            <span className="px-2 py-1 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-xs">
              LocalStorage near 5MB limit
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {driveCount > 0 && (
            <button
              type="button"
              onClick={handlePruneSynced}
              className="btn btn-secondary px-2.5 py-1 min-h-[40px] sm:min-h-[32px] whitespace-nowrap text-xs"
              title="Frees local storage by trimming cache of notes already backed up in Google Drive"
            >
              <Sparkles className="w-3 h-3 text-amber-500" />
              <span>Clean Synced Cache</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleExportBackup}
            disabled={unifiedCreations.length === 0}
            className="btn btn-secondary px-2.5 py-1 min-h-[40px] sm:min-h-[32px] whitespace-nowrap text-[11px]"
            title="Download complete JSON backup of all creations"
          >
            <FileDown className="w-3 h-3" />
            <span>Backup JSON</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn btn-secondary px-2.5 py-1 min-h-[40px] sm:min-h-[32px] whitespace-nowrap text-[11px]"
            title="Import creations from a JSON backup file (e.g. migrate between local and Vercel)"
          >
            <FileUp className="w-3 h-3" />
            <span>Import Backup</span>
          </button>
        </div>
      </div>
    </section>
  );
};
