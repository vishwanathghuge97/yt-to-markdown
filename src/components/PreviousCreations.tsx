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
} from 'lucide-react';

interface PreviousCreationsProps {
  user: User | null;
  onAuthChange: (user: User | null) => void;
  onSelectCreation: (title: string, markdownContent: string) => void;
}

export const PreviousCreations: React.FC<PreviousCreationsProps> = ({
  user,
  onAuthChange,
  onSelectCreation,
}) => {
  const [files, setFiles] = useState<DriveUploadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionFileId, setActionFileId] = useState<string | null>(null);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadFiles(false);
    } else {
      setFiles([]);
      setNeedsAuth(true);
    }
  }, [user]);

  const loadFiles = async (isManual = false) => {
    try {
      setIsLoading(true);
      setIsSyncing(true);
      setStatusNotice(null);
      setNeedsAuth(false);

      if (isManual) {
        setStatusNotice('Syncing with Google Drive...');
      }

      const list = await listRecentDriveExports();
      setFiles(list);
      setNeedsAuth(false);

      if (isManual) {
        setStatusNotice(`✓ Up to date (${list.length} ${list.length === 1 ? 'file' : 'files'})`);
        setTimeout(() => setStatusNotice(null), 3000);
      }
    } catch (err: any) {
      if (err?.code === 'AUTH_REQUIRED') {
        setNeedsAuth(true);
        setStatusNotice(null);
      } else {
        setStatusNotice('Could not reach Google Drive. Please retry.');
        setTimeout(() => setStatusNotice(null), 4000);
      }
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  };

  const handleConnectDrive = async () => {
    try {
      setIsLoading(true);
      setStatusNotice(null);
      const res = await googleSignIn();
      if (res?.user) {
        onAuthChange(res.user);
        setNeedsAuth(false);
        const list = await listRecentDriveExports();
        setFiles(list);
      }
    } catch (err) {
      // User cancelled popup or closed
    } finally {
      setIsLoading(false);
    }
  };

  const handleView = async (file: DriveUploadResult) => {
    try {
      setActionFileId(file.id);
      const content = await fetchDriveFileContent(file.id);
      const cleanTitle = file.name.replace(/\.md$/i, '');
      onSelectCreation(cleanTitle, content);
      // Smoothly scroll back to top preview
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setStatusNotice('Failed to load note content.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

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
    } catch {
      setStatusNotice('Failed to copy note.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

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
    } catch {
      setStatusNotice('Failed to download note.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

  const handleDelete = async (fileId: string) => {
    try {
      setActionFileId(fileId);
      await deleteDriveFile(fileId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      setConfirmDeleteId(null);
      setStatusNotice('Note deleted from Google Drive.');
      setTimeout(() => setStatusNotice(null), 3000);
    } catch {
      setStatusNotice('Failed to delete note from Google Drive.');
      setTimeout(() => setStatusNotice(null), 3000);
    } finally {
      setActionFileId(null);
    }
  };

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
              {files.length > 0 && !needsAuth && (
                <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {files.length}
                </span>
              )}
            </div>
            <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
              Saved notes in your Google Drive folder
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {statusNotice && (
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 animate-in fade-in duration-150">
              {statusNotice}
            </span>
          )}

          {!needsAuth && user && (
            <button
              type="button"
              onClick={() => loadFiles(true)}
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
              <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      {needsAuth || !user ? (
        <div className="py-8 px-4 text-center space-y-3.5 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50/50 dark:bg-zinc-950/40">
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 flex items-center justify-center mx-auto text-blue-600 dark:text-blue-400">
            <HardDrive className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {user ? 'Authorize Google Drive Sync' : 'Connect Google Drive to View Saved Notes'}
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto leading-relaxed">
              {user
                ? `Signed in as ${user.email}. Google requires 1-click authorization to access your "YouTube Summaries & Notes" folder.`
                : 'Your previous creations are stored in your Google Drive folder. Connect your Google account to browse, copy, and view them.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleConnectDrive}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-medium font-mono transition shadow-2xs active:scale-95 cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Authorizing...</span>
              </>
            ) : (
              <>
                <HardDrive className="w-3.5 h-3.5" />
                <span>{user ? 'Authorize Drive Access' : 'Connect Google Drive'}</span>
              </>
            )}
          </button>
        </div>
      ) : isLoading && files.length === 0 ? (
        <div className="py-12 text-center space-y-2">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400 mx-auto" />
          <p className="text-xs font-mono text-zinc-500">Checking Google Drive for saved notes...</p>
        </div>
      ) : files.length === 0 ? (
        <div className="py-8 text-center space-y-2 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg">
          <FileText className="w-7 h-7 text-zinc-300 dark:text-zinc-700 mx-auto" />
          <h4 className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
            No saved notes in your Google Drive yet
          </h4>
          <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
            When you generate video notes above, click the <strong>Drive</strong> button to save them for quick access anytime.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Search bar */}
          {files.length > 2 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter saved notes by title..."
                className="w-full pl-8 pr-3 py-1.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-md text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400"
              />
            </div>
          )}

          {/* Cards Grid */}
          <div
            className={`grid grid-cols-1 md:grid-cols-2 gap-2.5 transition-opacity duration-200 ${
              isSyncing ? 'opacity-60 pointer-events-none' : 'opacity-100'
            }`}
          >
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
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950/60 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-2xs transition-all duration-150 flex flex-col justify-between gap-2.5"
                >
                  {/* Top info */}
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4
                        className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1"
                        title={displayName}
                      >
                        {displayName}
                      </h4>
                      {file.webViewLink && (
                        <a
                          href={file.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition shrink-0"
                          aria-label="Open in Google Drive"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 mt-1">
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
                          onClick={() => handleDelete(file.id)}
                          disabled={isBusy}
                          className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium flex items-center gap-1"
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
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

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleCopy(file)}
                          disabled={isBusy}
                          className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95"
                          aria-label="Copy markdown"
                        >
                          {isCopied ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownload(file)}
                          disabled={isBusy}
                          className="p-1.5 rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95"
                          aria-label="Download markdown"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(file.id)}
                          disabled={isBusy}
                          className="p-1.5 rounded text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition active:scale-95"
                          aria-label="Delete note"
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
