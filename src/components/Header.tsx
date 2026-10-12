import React from 'react';
import { User } from 'firebase/auth';
import { LogOut, HardDrive, Sun, Moon, Key } from 'lucide-react';
import { googleSignIn, logout } from '../services/firebase';

interface HeaderProps {
  user: User | null;
  onAuthChange: (user: User | null) => void;
  onOpenDriveModal?: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  apiKey: string;
  onOpenApiKeyModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onAuthChange,
  onOpenDriveModal,
  darkMode,
  onToggleDarkMode,
  apiKey,
  onOpenApiKeyModal,
}) => {
  const [isSigningIn, setIsSigningIn] = React.useState(false);

  const handleSignIn = async () => {
    try {
      setIsSigningIn(true);
      const result = await googleSignIn();
      if (result) {
        onAuthChange(result.user);
      }
    } catch (err) {
      console.error('Failed to sign in:', err);
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    onAuthChange(null);
  };

  return (
    <header className="bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-40 transition-colors">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Brand: Pure Utilitarian Tool Identity */}
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded border border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center font-mono text-[11px] font-bold text-white dark:text-zinc-950">
            MD
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 tracking-tight">
              yt-to-markdown
            </span>
            <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
              v1.2.0
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center space-x-2">
          {/* API Key configuration button */}
          <button
            onClick={onOpenApiKeyModal}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-mono transition border ${
              apiKey
                ? 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60'
            }`}
            title="Configure your Gemini API key"
          >
            <Key className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {apiKey ? 'API Key Set' : 'Set API Key'}
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                apiKey ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
              }`}
            />
          </button>

          {/* Dark Mode */}
          <button
            onClick={onToggleDarkMode}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-900 border border-transparent hover:border-zinc-200 dark:hover:border-zinc-800 transition"
            title={darkMode ? 'Light mode' : 'Dark mode'}
          >
            {darkMode ? <Sun className="w-4 h-4 text-zinc-300" /> : <Moon className="w-4 h-4 text-zinc-600" />}
          </button>

          {/* Google Drive Connect */}
          {user ? (
            <div className="flex items-center space-x-1.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md py-1 px-2 text-xs">
              <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[100px]">
                {user.email?.split('@')[0]}
              </span>

              {onOpenDriveModal && (
                <button
                  onClick={onOpenDriveModal}
                  className="px-1.5 py-0.5 text-[11px] font-mono rounded bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-1 transition"
                  title="Google Drive export destination"
                >
                  <HardDrive className="w-3 h-3 text-zinc-600 dark:text-zinc-400" />
                  <span>Drive</span>
                </button>
              )}

              <button
                onClick={handleSignOut}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-0.5 rounded transition"
                title="Disconnect"
              >
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleSignIn}
              disabled={isSigningIn}
              className="inline-flex items-center border border-zinc-300 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-2.5 py-1.5 rounded-md text-xs font-mono text-zinc-700 dark:text-zinc-300 transition active:scale-[0.98] disabled:opacity-50"
            >
              <HardDrive className="w-3.5 h-3.5 mr-1.5 text-zinc-500" />
              <span>{isSigningIn ? 'Connecting...' : 'Connect Drive'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
