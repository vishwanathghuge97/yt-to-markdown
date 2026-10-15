import React from 'react';
import { User } from 'firebase/auth';
import { LogOut, HardDrive, Sun, Moon, Key, AlertCircle, X } from 'lucide-react';
import { googleSignIn, logout, formatAuthError } from '../services/firebase';

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
    <header className="bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-40 transition-colors">
      <div className="max-w-5xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2">
        {/* Brand: Pure Utilitarian Tool Identity */}
        <div className="flex items-center space-x-2 shrink-0">
          <div className="w-7 h-7 rounded border border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center font-mono text-[11px] font-bold text-white dark:text-zinc-950">
            MD
          </div>
          <div className="flex items-baseline space-x-1.5">
            <span className="font-semibold text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 tracking-tight">
              yt-to-markdown
            </span>
            <span className="hidden sm:inline text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
              v1.2.0
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
          {/* API Key configuration button */}
          <button
            onClick={onOpenApiKeyModal}
            className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 min-h-[38px] rounded-md text-xs font-mono transition border touch-manipulation active:scale-95 ${
              apiKeyCount > 0
                ? 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60'
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
                apiKeyCount > 0 ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
              }`}
            />
          </button>

          {/* Dark Mode */}
          <button
            onClick={onToggleDarkMode}
            className="p-2 min-h-[38px] min-w-[38px] flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-900 border border-transparent hover:border-zinc-200 dark:hover:border-zinc-800 transition touch-manipulation active:scale-95"
            title={darkMode ? 'Light mode' : 'Dark mode'}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun className="w-4 h-4 text-zinc-300" /> : <Moon className="w-4 h-4 text-zinc-600" />}
          </button>

          {/* Google Drive Connect */}
          {user ? (
            <div className="flex items-center space-x-1 sm:space-x-1.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md py-1 px-1.5 sm:px-2 text-xs min-h-[38px]">
              <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[65px] sm:max-w-[110px] text-[11px] sm:text-xs">
                {user.email?.split('@')[0]}
              </span>

              {onOpenDriveModal && (
                <button
                  onClick={onOpenDriveModal}
                  disabled={!hasReport}
                  className="px-1.5 py-1 text-[11px] font-mono rounded bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-1 transition touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
                  title={
                    hasReport
                      ? 'Google Drive export destination'
                      : 'Generate a note first to enable Drive export'
                  }
                  aria-label="Google Drive export destination"
                >
                  <HardDrive className="w-3 h-3 text-zinc-600 dark:text-zinc-400" />
                  <span className="hidden sm:inline">Drive</span>
                </button>
              )}

              <button
                onClick={handleSignOut}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1 rounded transition touch-manipulation"
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
              className="inline-flex items-center justify-center border border-zinc-300 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-2.5 py-1.5 min-h-[38px] rounded-md text-xs font-mono text-zinc-700 dark:text-zinc-300 transition active:scale-95 disabled:opacity-50 touch-manipulation"
              title="Connect Google Drive to export notes directly"
            >
              <HardDrive className="w-3.5 h-3.5 sm:mr-1.5 text-zinc-500 shrink-0" />
              <span className="hidden sm:inline">{isSigningIn ? 'Connecting...' : 'Connect Drive'}</span>
            </button>
          )}
        </div>
      </div>

      {authError && (
        <div className="bg-amber-50 dark:bg-amber-950/80 border-t border-amber-200 dark:border-amber-800 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="truncate">{authError}</span>
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

