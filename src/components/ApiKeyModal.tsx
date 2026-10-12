import React, { useState } from 'react';
import { Key, Check, ExternalLink, X, ShieldCheck } from 'lucide-react';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKey: string;
  onSaveKey: (key: string, persist: boolean) => void;
  hasEnvKey: boolean;
  initialPersist?: boolean;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  apiKey,
  onSaveKey,
  hasEnvKey,
  initialPersist = true,
}) => {
  const [inputVal, setInputVal] = useState(apiKey);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [persistLocally, setPersistLocally] = useState(initialPersist);

  // Sync state when opened
  React.useEffect(() => {
    if (isOpen) {
      setInputVal(apiKey);
      setSavedSuccess(false);
      setPersistLocally(initialPersist);
    }
  }, [isOpen, apiKey, initialPersist]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputVal.trim();
    onSaveKey(clean, persistLocally);
    setSavedSuccess(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  const handleClear = () => {
    setInputVal('');
    onSaveKey('', false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                Gemini API Keys
              </h3>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Bring your own API key (BYOK)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSave} className="p-5 space-y-4">
          <div className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed space-y-2">
            <p>
              Add multiple keys, one per line. The app automatically tries the next key when one is rejected, rate-limited, or exhausted.
            </p>
            <div className="bg-zinc-50 dark:bg-zinc-950 p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-zinc-800 dark:text-zinc-200">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>How your key is kept safe:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-zinc-500 dark:text-zinc-400 pl-1">
                <li><strong>Browser Sandbox:</strong> Other websites (like Facebook, Google, other tabs) cannot read data saved on this domain due to browser Same-Origin isolation.</li>
                <li><strong>Never Logged or Stored:</strong> Your key is never written to any database, file, or server log.</li>
              </ul>
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              API Keys (one per line):
            </label>
            <div className="relative">
              <textarea
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder={'AIzaSy...\nAIzaSy...'}
                rows={4}
                spellCheck={false}
                className="w-full px-3 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-800 rounded-lg text-base sm:text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 resize-y"
              />
            </div>
          </div>

          {/* Storage Mode Choice */}
          <div className="space-y-1.5 pt-1">
            <label className="block text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
              Storage Preference:
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${!persistLocally ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-100/70 dark:bg-zinc-800/60 font-medium text-zinc-900 dark:text-zinc-100' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}`}>
                <input
                  type="radio"
                  name="storage_mode"
                  checked={!persistLocally}
                  onChange={() => setPersistLocally(false)}
                  className="mt-0.5"
                />
                <div className="text-[11px] leading-tight">
                  <div className="font-semibold text-zinc-800 dark:text-zinc-200">Session Only</div>
                  <div className="text-[10px] text-zinc-500">Erased when tab closes (Most secure)</div>
                </div>
              </label>

              <label className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${persistLocally ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-100/70 dark:bg-zinc-800/60 font-medium text-zinc-900 dark:text-zinc-100' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}`}>
                <input
                  type="radio"
                  name="storage_mode"
                  checked={persistLocally}
                  onChange={() => setPersistLocally(true)}
                  className="mt-0.5"
                />
                <div className="text-[11px] leading-tight">
                  <div className="font-semibold text-zinc-800 dark:text-zinc-200">Remember</div>
                  <div className="text-[10px] text-zinc-500">Saved on this device only</div>
                </div>
              </label>
            </div>
          </div>

          {/* Helper link */}
          <div className="flex items-center justify-between text-[11px] pt-1">
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              <span>Get a free key from Google AI Studio</span>
              <ExternalLink className="w-3 h-3" />
            </a>

            {inputVal && (
              <button
                type="button"
                onClick={handleClear}
                className="text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 font-mono transition"
              >
                Clear key
              </button>
            )}
          </div>

          {savedSuccess && (
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>Key saved successfully!</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-mono rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-mono font-medium rounded-lg bg-zinc-900 hover:bg-black dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-950 transition shadow-xs"
            >
              Save Key
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
