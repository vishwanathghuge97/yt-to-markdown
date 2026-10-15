import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { User } from 'firebase/auth';
import {
  DriveUploadResult,
  listRecentDriveExports,
  fetchDriveFileContent,
  deleteDriveFile,
  saveMarkdownToDrive,
} from '../services/googleDrive';
import { googleSignIn, formatAuthError } from '../services/firebase';
import {
  getLocalCreations,
  deleteLocalCreation,
  updateCreationDriveInfo,
  CreationRecord,
} from '../services/creationStorage';
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
}

export const PreviousCreations: React.FC<PreviousCreationsProps> = ({
  user,
  onAuthChange,
  onSelectCreation,
  lastGeneratedTime,
}) => {
  const [localCreations, setLocalCreations] = useState<CreationRecord[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveUploadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'drive' | 'local'>('all');
  const [actionFileId, setActionFileId] = useState<string | null>(null);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [savingToDriveId, setSavingToDriveId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);

  // Reload local creations on mount and whenever lastGeneratedTime updates
  const reloadLocalCreations = useCallback(() => {
    const records = getLocalCreations();
    setLocalCreations(records);
  }, []);

  useEffect(() => {
    reloadLocalCreations();
  }, [reloadLocalCreations, lastGeneratedTime]);

  // Load Google Drive files if user is signed in
  const loadDriveFiles = useCallback(
    async (isManual = false) => {
      if (!user) {
        setDriveFiles([]);
        setNeedsAuth(true);
        return;
      }

      try {
        setIsLoading(true);
        setIsSyncing(true);
        setAuthErrorMessage(null);
        if (isManual) {
          setStatusNotice('Syncing with Google Drive...');
        }

        const list = await listRecentDriveExports();
        setDriveFiles(list);
        setNeedsAuth(false);

        if (isManual) {
          setStatusNotice(
            `✓ Synced (${list.length} Drive ${list.length === 1 ? 'file' : 'files'})`
          );
          setTimeout(() => setStatusNotice(null), 3000);
        }
      } catch (err: any) {
        if (err?.code === 'AUTH_REQUIRED') {
          setNeedsAuth(true);
        } else {
          const formatted = formatAuthError(err);
          setAuthErrorMessage(formatted);
          setStatusNotice('Could not reach Google Drive.');
          setTimeout(() => setStatusNotice(null), 4000);
        }
      } finally {
        setIsLoading(false);
        setIsSyncing(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (user) {
      loadDriveFiles(false);
    } else {
      setDriveFiles([]);
      setNeedsAuth(true);
    }
  }, [user, loadDriveFiles]);

  const handleConnectDrive = async () => {
    try {
      setIsLoading(true);
      setAuthErrorMessage(null);
      setStatusNotice(null);
      const res = await googleSignIn();
      if (res?.user) {
        onAuthChange(res.user);
        setNeedsAuth(false);
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

    // 1. Add all local creations
    for (const item of localCreations) {
      const normalizedTitle = item.title.trim().toLowerCase().replace(/\.md$/i, '');
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
      const normalizedTitle = cleanName.toLowerCase();

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

    // Sort descending by creation date
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
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

  // Load content (either from local or Drive) and select it for viewing
  const handleView = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      let content = item.markdownContent;

      if (!content && item.driveFileId) {
        setStatusNotice('Fetching from Google Drive...');
        content = await fetchDriveFileContent(item.driveFileId);
        setStatusNotice(null);
      }

      if (content) {
        onSelectCreation(item.title, content);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setStatusNotice('No content available for this note.');
        setTimeout(() => setStatusNotice(null), 3000);
      }
    } catch {
      setStatusNotice('Failed to load note content.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

  const handleCopy = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      let content = item.markdownContent;

      if (!content && item.driveFileId) {
        content = await fetchDriveFileContent(item.driveFileId);
      }

      if (!content) throw new Error('No content');

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedFileId(item.id);
      setTimeout(() => setCopiedFileId(null), 2000);
    } catch {
      setStatusNotice('Failed to copy note.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

  const handleDownload = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      let content = item.markdownContent;

      if (!content && item.driveFileId) {
        content = await fetchDriveFileContent(item.driveFileId);
      }

      if (!content) throw new Error('No content');

      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.title.endsWith('.md') ? item.title : `${item.title}.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      setStatusNotice('Failed to download note.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

  // Push a local creation to Google Drive
  const handleSaveToDrive = async (item: UnifiedCreation) => {
    if (!item.markdownContent) return;
    try {
      setSavingToDriveId(item.id);
      setStatusNotice('Uploading note to Google Drive...');
      const result = await saveMarkdownToDrive(
        item.title,
        item.markdownContent,
        `Exported summary for ${item.title}`
      );
      updateCreationDriveInfo(item.id, result.id, result.webViewLink);
      reloadLocalCreations();
      await loadDriveFiles(false);
      setStatusNotice('✓ Saved to Google Drive!');
      setTimeout(() => setStatusNotice(null), 3000);
    } catch (err: any) {
      const formatted = formatAuthError(err);
      setAuthErrorMessage(formatted);
      setStatusNotice('Failed to save to Google Drive.');
      setTimeout(() => setStatusNotice(null), 4000);
    } finally {
      setSavingToDriveId(null);
    }
  };

  const handleDelete = async (item: UnifiedCreation) => {
    try {
      setActionFileId(item.id);
      // Remove from local storage
      deleteLocalCreation(item.id);
      deleteLocalCreation(item.title);
      reloadLocalCreations();

      // If it exists in Drive and Drive is connected, delete from Drive too
      if (item.driveFileId && user) {
        try {
          await deleteDriveFile(item.driveFileId);
          setDriveFiles((prev) => prev.filter((f) => f.id !== item.driveFileId));
        } catch (e) {
          console.warn('Could not delete from Drive:', e);
        }
      }

      setConfirmDeleteId(null);
      setStatusNotice('Note deleted.');
      setTimeout(() => setStatusNotice(null), 3000);
    } catch {
      setStatusNotice('Failed to delete note.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

  const formatDate = (isoString?: string) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
      });
    } catch {
      return '';
    }
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
      className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 sm:p-5 shadow-xs transition-colors duration-150 space-y-4"
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-100 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-900 dark:text-zinc-100 shrink-0">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Previous Creations
              </h2>
              {unifiedCreations.length > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {unifiedCreations.length}
                </span>
              )}
            </div>
            <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
              Persistent storage in browser and synchronized with Google Drive
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {statusNotice && (
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 animate-in fade-in duration-150">
              {statusNotice}
            </span>
          )}

          {user ? (
            <button
              type="button"
              onClick={() => loadDriveFiles(true)}
              disabled={isSyncing}
              className={`px-2.5 py-1.5 rounded-md text-xs font-mono flex items-center gap-1.5 transition touch-manipulation border border-zinc-200 dark:border-zinc-800 ${
                isSyncing
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'
                  : 'bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
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
          ) : (
            <button
              type="button"
              onClick={handleConnectDrive}
              disabled={isLoading}
              className="px-2.5 py-1.5 rounded-md text-xs font-mono flex items-center gap-1.5 bg-blue-50 dark:bg-blue-950/50 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 transition"
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Connect Drive</span>
            </button>
          )}
        </div>
      </div>

      {/* Production / Vercel Domain Notice Banner if auth failed */}
      {authErrorMessage && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-semibold">{authErrorMessage}</p>
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              Note: Your local creations remain completely safe and accessible below even if Google Drive authorization is pending.
            </p>
          </div>
        </div>
      )}

      {/* Tabs & Search */}
      {unifiedCreations.length > 0 && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-1">
          {/* Tabs */}
          <div className="inline-flex rounded-md bg-zinc-100 dark:bg-zinc-800 p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              className={`px-2.5 py-1 rounded transition ${
                activeTab === 'all'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-2xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              All ({unifiedCreations.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('drive')}
              className={`px-2.5 py-1 rounded transition flex items-center gap-1 ${
                activeTab === 'drive'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-2xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Cloud className="w-3 h-3 text-blue-500" />
              <span>In Drive ({driveCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('local')}
              className={`px-2.5 py-1 rounded transition flex items-center gap-1 ${
                activeTab === 'local'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-medium shadow-2xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Laptop className="w-3 h-3 text-zinc-500" />
              <span>Local ({localOnlyCount})</span>
            </button>
          </div>

          {/* Search box */}
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search creations..."
              className="w-full pl-8 pr-3 py-1 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-md text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400"
            />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {unifiedCreations.length === 0 ? (
        <div className="py-8 px-4 text-center space-y-3.5 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50/50 dark:bg-zinc-950/40">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center mx-auto text-zinc-500">
            <FileText className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              No saved creations yet
            </h4>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto leading-relaxed">
              When you generate notes for any YouTube video above, they will automatically be preserved here and can be exported directly to your Google Drive.
            </p>
          </div>
          {!user && (
            <button
              type="button"
              onClick={handleConnectDrive}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-mono transition active:scale-95 cursor-pointer"
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
            className={`grid grid-cols-1 md:grid-cols-2 gap-2.5 transition-opacity duration-200 ${
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
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950/60 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-2xs transition-all duration-150 flex flex-col justify-between gap-2.5"
                >
                  {/* Top info */}
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4
                        className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1"
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

                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 mt-1">
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
                    <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] font-mono">
                      <span className="text-rose-600 dark:text-rose-400 font-medium">
                        Delete note?
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item)}
                          disabled={isBusy}
                          className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium flex items-center gap-1 cursor-pointer"
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
                          className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-black dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 text-xs font-mono font-medium transition flex items-center gap-1.5 touch-manipulation active:scale-95 disabled:opacity-50 cursor-pointer"
                        >
                          {isBusy && actionFileId === item.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                          <span>View</span>
                        </button>

                        {/* If note is local only, show quick Save to Drive button */}
                        {!item.driveFileId && item.markdownContent && user && (
                          <button
                            type="button"
                            onClick={() => handleSaveToDrive(item)}
                            disabled={isSavingDrive}
                            className="px-2 py-1 rounded bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 text-[11px] font-mono flex items-center gap-1 transition"
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
                          className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95"
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
                          className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95"
                          aria-label="Download markdown"
                          title="Download .md file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          disabled={isBusy}
                          className="p-1.5 rounded text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition active:scale-95"
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
    </section>
  );
};
