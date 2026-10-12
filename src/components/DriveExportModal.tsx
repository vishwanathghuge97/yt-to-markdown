import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import {
  saveMarkdownToDrive,
  listRecentDriveExports,
  DriveUploadResult,
} from '../services/googleDrive';
import { googleSignIn } from '../services/firebase';
import {
  HardDrive,
  FolderCheck,
  CheckCircle2,
  ExternalLink,
  X,
  Loader2,
  FileText,
  AlertCircle,
} from 'lucide-react';

interface DriveExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onAuthChange: (user: User | null) => void;
  fileName: string;
  markdownContent: string;
  videoTitle: string;
}

export const DriveExportModal: React.FC<DriveExportModalProps> = ({
  isOpen,
  onClose,
  user,
  onAuthChange,
  fileName,
  markdownContent,
  videoTitle,
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<DriveUploadResult | null>(null);
  const [recentFiles, setRecentFiles] = useState<DriveUploadResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && user) {
      loadRecentFiles();
    }
  }, [isOpen, user]);

  const loadRecentFiles = async () => {
    try {
      const files = await listRecentDriveExports();
      setRecentFiles(files);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSignIn = async () => {
    try {
      const res = await googleSignIn();
      if (res) {
        onAuthChange(res.user);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to authenticate with Google');
    }
  };

  const handleConfirmExport = async () => {
    if (!user) {
      await handleSignIn();
      return;
    }

    try {
      setIsExporting(true);
      setErrorMessage(null);
      const res = await saveMarkdownToDrive(
        fileName,
        markdownContent,
        `Multimodal transcript and summary for: ${videoTitle}`
      );
      setExportResult(res);
      await loadRecentFiles();
    } catch (err: any) {
      console.error('Drive export error:', err);
      setErrorMessage(err.message || 'Failed to save file to Google Drive');
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 dark:bg-black/70 backdrop-blur-xs">
      <div className="bg-white dark:bg-zinc-900 rounded-xl sm:rounded-2xl max-w-lg w-full max-h-[90dvh] overflow-y-auto border border-slate-200 dark:border-zinc-800 shadow-2xl flex flex-col transition-colors">
        {/* Header */}
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/40 border border-blue-100 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
              <HardDrive className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-zinc-100">
                Save to Google Drive
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-zinc-400">
                Export markdown report to your Drive folder
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 p-1.5 rounded-lg transition touch-manipulation"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 space-y-3.5 sm:space-y-4">
          {errorMessage && (
            <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Details */}
          <div className="bg-slate-50 dark:bg-zinc-800/40 rounded-xl p-3.5 sm:p-4 border border-slate-200 dark:border-zinc-800 space-y-2 text-xs">
            <div className="flex justify-between items-center text-slate-600 dark:text-zinc-400">
              <span className="font-medium">Folder:</span>
              <span className="font-mono text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-1">
                <FolderCheck className="w-3.5 h-3.5" />
                YouTube Summaries & Notes
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-600 dark:text-zinc-400">
              <span className="font-medium">File Name:</span>
              <span className="font-mono text-slate-900 dark:text-zinc-200 font-medium truncate max-w-[200px] sm:max-w-[260px]">
                {fileName.endsWith('.md') ? fileName : `${fileName}.md`}
              </span>
            </div>
          </div>

          {/* Export Success */}
          {exportResult && (
            <div className="p-3.5 sm:p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-xl space-y-2.5">
              <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 text-xs font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Saved successfully to your Google Drive!</span>
              </div>

              {exportResult.webViewLink && (
                <a
                  href={exportResult.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition touch-manipulation"
                >
                  <span>Open in Google Drive</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          )}

          {/* Recent Exports */}
          {user && recentFiles.length > 0 && (
            <div className="pt-1">
              <p className="text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-2">
                Recent Drive files in folder:
              </p>
              <div className="space-y-1.5 max-h-28 overflow-y-auto">
                {recentFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700 text-xs"
                  >
                    <div className="flex items-center gap-2 truncate mr-2">
                      <FileText className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                      <span className="truncate text-slate-800 dark:text-zinc-200">{file.name}</span>
                    </div>
                    {file.webViewLink && (
                      <a
                        href={file.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 p-1 shrink-0"
                        title="Open file"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-3 sm:py-4 bg-slate-50 dark:bg-zinc-800/60 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="px-3.5 py-2 min-h-[40px] border border-slate-300 dark:border-zinc-700 rounded-lg text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition touch-manipulation"
          >
            Cancel
          </button>

          <button
            onClick={handleConfirmExport}
            disabled={isExporting}
            className="px-4 py-2 min-h-[40px] bg-blue-600 hover:bg-blue-700 active:scale-95 text-white rounded-lg text-xs font-semibold transition flex items-center gap-2 shadow-xs disabled:opacity-50 touch-manipulation"
          >
            {isExporting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <HardDrive className="w-3.5 h-3.5" />
                <span>{user ? 'Save to Drive' : 'Sign in & Save'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
