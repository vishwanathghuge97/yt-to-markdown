import React, { useState, useEffect, useMemo } from 'react';
import { User } from 'firebase/auth';
import {
  DriveUploadResult,
  listRecentDriveExports,
  fetchDriveFileContent,
  deleteDriveFile,
} from '../services/googleDrive';
import { googleSignIn } from '../services/firebase';
import {
  X,
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
  AlertCircle,
  Loader2,
} from 'lucide-react';

interface HistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
  onSelectCreation: (title: string, markdownContent: string) => void;
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
  isOpen,
  onClose,
  user,
  onAuthChange,
  onSelectCreation,
}) => {
  const [files, setFiles] = useState<DriveUploadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<{
    type: 'syncing' | 'success' | 'error';
    message: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionFileId, setActionFileId] = useState<string | null>(null);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Load files when opened
  useEffect(() => {
    if (isOpen && user) {
      loadFiles();
    }
  }, [isOpen, user]);

  const loadFiles = async (isManual = false) => {
    try {
      setIsLoading(true);
      setIsSyncing(true);
      setErrorMessage(null);
      if (isManual) {
        setSyncFeedback({ type: 'syncing', message: 'Syncing with Google Drive...' });
      }
      const list = await listRecentDriveExports();
      setFiles(list);
      setSyncFeedback({
        type: 'success',
        message: `Up to date (${list.length} ${list.length === 1 ? 'file' : 'files'} found)`,
      });
      setTimeout(() => {
        setSyncFeedback((prev) => (prev?.type === 'success' ? null : prev));
      }, 3500);
    } catch (err: any) {
      const msg = err?.message || 'Could not load your previous creations from Google Drive.';
      setErrorMessage(msg);
      setSyncFeedback({ type: 'error', message: msg });
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  };

  const handleSignIn = async () => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const res = await googleSignIn();
      if (res?.user) {
        onAuthChange(res.user);
        const list = await listRecentDriveExports();
        setFiles(list);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to authenticate with Google Drive');
    } finally {
      setIsLoading(false);
    }
  };

  // 1. View / Open note
  const handleView = async (file: DriveUploadResult) => {
    try {
      setActionFileId(file.id);
      const content = await fetchDriveFileContent(file.id);
      const cleanTitle = file.name.replace(/\.md$/i, '');
      onSelectCreation(cleanTitle, content);
      onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to load note content');
    } finally {
      setActionFileId(null);
    }
  };

  // 2. Copy markdown
  const handleCopy = async (file: DriveUploadResult) => {
    try {
      setActionFileId(file.id);
      const content = await fetchDriveFileContent(file.id);
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
      setCopiedFileId(file.id);
      setTimeout(() => setCopiedFileId(null), 2000);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to copy note');
    } finally {
      setActionFileId(null);
    }
  };

  // 3. Download .md
  const handleDownload = async (file: DriveUploadResult) => {
    try {
      setActionFileId(file.id);
      const content = await fetchDriveFileContent(file.id);
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name.endsWith('.md') ? file.name : `${file.name}.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to download note');
    } finally {
      setActionFileId(null);
    }
  };

  // 4. Delete file
  const handleDelete = async (fileId: string) => {
    try {
      setActionFileId(fileId);
      await deleteDriveFile(fileId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      setConfirmDeleteId(null);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to delete note from Google Drive');
    } finally {
      setActionFileId(null);
    }
  };

  // Filter files
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, searchQuery]);

  const formatDate = (isoString?: string) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const formatSize = (bytesStr?: string) => {
    if (!bytesStr) return '';
    const bytes = parseInt(bytesStr, 10);
    if (isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Container */}
      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col font-sans transition-colors">
          {/* Header */}
          <div className="px-4 sm:px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-900 dark:text-zinc-100 shrink-0">
                <Clock className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  Previous Creations
                </h2>
                <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                  {user ? `${files.length} saved in Google Drive` : 'Google Drive Storage'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {user && (
                <button
                  type="button"
                  onClick={() => loadFiles(true)}
                  disabled={isSyncing}
                  className={`px-2 py-1 rounded-md text-xs font-mono flex items-center gap-1.5 transition touch-manipulation active:scale-95 ${
                    isSyncing
                      ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 cursor-not-allowed opacity-80'
                      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                  aria-label="Sync with Google Drive"
                >
                  <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? 'animate-spin text-blue-600 dark:text-blue-400' : ''}`} />
                  <span className="text-[11px] font-medium">{isSyncing ? 'Syncing...' : 'Sync'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                aria-label="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Sync Status Feedback Banner */}
          {syncFeedback && (
            <div
              className={`px-4 py-2 border-b text-xs font-mono flex items-center justify-between transition-colors ${
                syncFeedback.type === 'syncing'
                  ? 'bg-blue-50/70 dark:bg-blue-950/40 border-blue-200/80 dark:border-blue-900/60 text-blue-800 dark:text-blue-300'
                  : syncFeedback.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-300'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {syncFeedback.type === 'syncing' && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-blue-600 dark:text-blue-400" />
                )}
                {syncFeedback.type === 'success' && (
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
                {syncFeedback.type === 'error' && (
                  <AlertCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0" />
                )}
                <span className="truncate text-[11px]">{syncFeedback.message}</span>
              </div>
              {syncFeedback.type === 'error' && (
                <button
                  type="button"
                  onClick={() => loadFiles(true)}
                  className="shrink-0 px-2 py-0.5 rounded border border-rose-300 dark:border-rose-800 bg-white dark:bg-zinc-900 hover:bg-rose-100 dark:hover:bg-rose-950 text-[10px] font-semibold text-rose-800 dark:text-rose-200 ml-2"
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {/* Search bar (when authenticated) */}
          {user && files.length > 0 && (
            <div className="p-3 border-b border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/40">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter saved notes by title..."
                  className="w-full pl-8 pr-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400"
                />
              </div>
            </div>
          )}

          {/* Body */}
          <div className={`flex-1 overflow-y-auto p-4 space-y-3 transition-opacity duration-150 ${isSyncing ? 'opacity-60' : 'opacity-100'}`}>
            {errorMessage && (
              <div className="p-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-300 text-xs font-mono flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {!user ? (
              <div className="py-12 px-4 text-center space-y-4">
                <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 flex items-center justify-center mx-auto text-blue-600 dark:text-blue-400">
                  <HardDrive className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    Connect Google Drive
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
                    Connect your Google Drive to view, copy, download, and manage your previous video notes.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSignIn}
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-medium font-mono transition shadow-xs"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : (
                    <>
                      <HardDrive className="w-3.5 h-3.5" />
                      <span>Connect Google Drive</span>
                    </>
                  )}
                </button>
              </div>
            ) : isLoading && files.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <Loader2 className="w-6 h-6 animate-spin text-zinc-400 mx-auto" />
                <p className="text-xs font-mono text-zinc-500">Loading your Drive creations...</p>
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <FileText className="w-8 h-8 text-zinc-300 dark:text-zinc-700 mx-auto" />
                <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {searchQuery ? 'No matching creations found' : 'No saved creations yet'}
                </h4>
                <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
                  {searchQuery
                    ? 'Try adjusting your search terms.'
                    : 'When you generate notes, click the Drive button to save them here for instant future access.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredFiles.map((file) => {
                  const isBusy = actionFileId === file.id;
                  const isCopied = copiedFileId === file.id;
                  const isConfirmingDelete = confirmDeleteId === file.id;
                  const displayName = file.name.replace(/\.md$/i, '');
                  const dateStr = formatDate(file.createdTime);
                  const sizeStr = formatSize(file.size);

                  return (
                    <div
                      key={file.id}
                      className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950/60 hover:border-zinc-300 dark:hover:border-zinc-700 transition shadow-2xs space-y-2.5"
                    >
                      {/* Title & Metadata */}
                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1">
                            {displayName}
                          </h4>
                          {file.webViewLink && (
                            <a
                              href={file.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 shrink-0"
                              aria-label="Open in Google Drive"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500 mt-0.5">
                          {dateStr && <span>{dateStr}</span>}
                          {dateStr && sizeStr && <span>·</span>}
                          {sizeStr && <span>{sizeStr}</span>}
                        </div>
                      </div>

                      {/* Action buttons */}
                      {isConfirmingDelete ? (
                        <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] font-mono">
                          <span className="text-rose-600 dark:text-rose-400 font-medium">
                            Delete permanently?
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(file.id)}
                              disabled={isBusy}
                              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium flex items-center gap-1"
                            >
                              {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
                          {/* Left: View primary action */}
                          <button
                            type="button"
                            onClick={() => handleView(file)}
                            disabled={isBusy}
                            className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-black dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 text-xs font-mono font-medium transition flex items-center gap-1.5 touch-manipulation active:scale-95 disabled:opacity-50"
                          >
                            {isBusy && actionFileId === file.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Eye className="w-3 h-3" />
                            )}
                            <span>View</span>
                          </button>

                          {/* Right: Quick tool actions */}
                          <div className="flex items-center gap-1">
                            {/* Copy Markdown */}
                            <button
                              type="button"
                              onClick={() => handleCopy(file)}
                              disabled={isBusy}
                              className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                              aria-label="Copy markdown"
                            >
                              {isCopied ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>

                            {/* Download */}
                            <button
                              type="button"
                              onClick={() => handleDownload(file)}
                              disabled={isBusy}
                              className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                              aria-label="Download markdown file"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>

                            {/* Delete trigger */}
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(file.id)}
                              disabled={isBusy}
                              className="p-1.5 rounded text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
                              aria-label="Delete creation"
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
