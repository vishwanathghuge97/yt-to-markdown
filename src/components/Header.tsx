import React from 'react';
import { User } from 'firebase/auth';
import { LogOut, HardDrive, Sun, Moon, Key, AlertCircle, X } from 'lucide-react';
import { googleSignIn, logout, formatAuthError } from '../services/firebase';
import { BrandMark } from './BrandMark';
import { DRIVE_ENABLED } from '../shared/features';

interface HeaderProps {
  user: User | null;
  onAuthChange: (user: User | null) => void;
  onOpenDriveModal?: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  /** Number of configured Gemini API keys (0 = none yet). */
  apiKeyCount: number;
  onOpenApiKeyModal: () => void;
  /** Enables the Drive export button; false while no note is loaded. */
  hasReport?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onAuthChange,
  onOpenDriveModal,
  darkMode,
  onToggleDarkMode,
  apiKeyCount,
  onOpenApiKeyModal,
  hasReport = false,
}) => {
  const [isSigningIn, setIsSigningIn] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);

  const handleSignIn = async () => {
    try {
      setIsSigningIn(true);
      setAuthError(null);
      const result = await googleSignIn();
      if (result) {
        onAuthChange(result.user);
      }
    } catch (err: any) {
      console.error('Failed to sign in:', err);
      const formatted = formatAuthError(err);
      setAuthError(formatted);
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logout();
      onAuthChange(null);
    } catch (err) {
      console.error('Failed to sign out:', err);
      setAuthError('Could not sign out. Please check your connection and try again.');
    }
  };

  return (
    <header className="bg-white/85 dark:bg-zinc-950/85 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-40 transition-colors">
      <div className="max-w-4xl sm:max-w-5xl 2xl:max-w-6xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-1.5 sm:gap-2">
        {/* Brand */}
        <div className="flex items-center space-x-2.5 shrink-0">
          <BrandMark className="w-8 h-8 rounded-lg shadow-xs shrink-0" />
          <div className="flex items-baseline space-x-1.5">
            <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 tracking-tight">
              yt-to-markdown
            </span>
            <span className="hidden sm:inline text-[10px] font-mono text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800 rounded px-1 py-px">
              v1.2.0
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
          {/* API Key configuration button */}
          <button
            onClick={onOpenApiKeyModal}
            className={`btn px-3 py-1.5 min-h-[40px] text-xs ${
              apiKeyCount > 0 ? 'btn-secondary' : 'btn-primary'
            }`}
            title="Configure your Gemini API key"
            aria-label="Configure Gemini API key"
          >
            <Key className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden md:inline">
              {apiKeyCount > 0
                ? `${apiKeyCount} API ${apiKeyCount === 1 ? 'Key' : 'Keys'}`
                : 'Set API Key'}
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                apiKeyCount > 0 ? 'bg-emerald-500' : 'bg-white/90 animate-pulse'
              }`}
            />
          </button>

          {/* Dark Mode */}
          <button
            onClick={onToggleDarkMode}
            className="btn btn-ghost p-2 min-h-[40px] min-w-[40px]"
            title={darkMode ? 'Light mode' : 'Dark mode'}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Google Drive Connect (hidden while the Drive feature is off) */}
          {DRIVE_ENABLED && (user ? (
            <div className="flex items-center space-x-1 sm:space-x-1.5 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg pl-2.5 pr-1 py-1 text-xs min-h-[40px]">
              <span className="hidden min-[360px]:inline-block font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[64px] sm:max-w-[110px] text-[11px] sm:text-xs">
                {user.email?.split('@')[0]}
              </span>

              {onOpenDriveModal && (
                <button
                  onClick={onOpenDriveModal}
                  disabled={!hasReport}
                  className="btn btn-ghost px-2 py-1 min-h-[32px] text-[11px]"
                  title={
                    hasReport
                      ? 'Google Drive export destination'
                      : 'Generate a note first to enable Drive export'
                  }
                  aria-label="Google Drive export destination"
                >
                  <HardDrive className="w-3 h-3" />
                  <span className="hidden sm:inline">Drive</span>
                </button>
              )}

              <button
                onClick={handleSignOut}
                className="btn btn-ghost p-1.5 min-h-[32px] min-w-[32px]"
                title="Disconnect"
                aria-label="Disconnect Google account"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleSignIn}
              disabled={isSigningIn}
              className="btn btn-secondary px-3 py-1.5 min-h-[40px] text-xs"
              title="Connect Google Drive to export notes directly"
              aria-label="Connect Google Drive"
            >
              <HardDrive className="w-3.5 h-3.5 sm:mr-0.5 text-zinc-500 shrink-0" />
              <span className="hidden sm:inline">{isSigningIn ? 'Connecting...' : 'Connect Drive'}</span>
            </button>
          ))}
        </div>
      </div>

      {authError && (
        <div className="bg-amber-50 dark:bg-amber-950/80 border-t border-amber-200 dark:border-amber-800 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 break-words">{authError}</span>
          </div>
          <button
            onClick={() => setAuthError(null)}
            className="p-1 text-amber-600 dark:text-amber-400 hover:text-amber-900 rounded shrink-0 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </header>
  );
};

