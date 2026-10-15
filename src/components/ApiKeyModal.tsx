import React, { useRef, useState } from 'react';
import { Key, Eye, EyeOff, Check, ExternalLink, X, ShieldCheck, Plus, Trash2 } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKey: string;
  onSaveKey: (key: string, persist: boolean) => void;
  initialPersist?: boolean;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  apiKey,
  onSaveKey,
  initialPersist = true,
}) => {
  const [keyValues, setKeyValues] = useState<string[]>(['']);
  const [visibleKeys, setVisibleKeys] = useState<Record<number, boolean>>({});
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [persistLocally, setPersistLocally] = useState(initialPersist);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape-to-close, background scroll lock, focus trap + restore.
  useDialogA11y(isOpen, onClose, panelRef);

  // Sync state when the dialog is opened.
  React.useEffect(() => {
    if (isOpen) {
      setKeyValues(apiKey.split('\n').map((key) => key.trim()).filter(Boolean).length > 0
        ? apiKey.split('\n').map((key) => key.trim()).filter(Boolean)
        : ['']);
      setVisibleKeys({});
      setSavedSuccess(false);
      setPersistLocally(initialPersist);
    }
  }, [isOpen, apiKey, initialPersist]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedKeys = keyValues.map((key) => key.trim()).filter(Boolean);
    onSaveKey(cleanedKeys.join('\n'), persistLocally);
    if (cleanedKeys.length === 0) {
      // Clearing all keys is a valid action, but it must not claim "saved".
      onClose();
      return;
    }
    setSavedSuccess(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  const handleClear = () => {
    setKeyValues(['']);
    setVisibleKeys({});
    onSaveKey('', false);
  };

  // Backdrop clicks intentionally do NOT close this dialog: it holds unsaved
  // API keys, and an accidental outside click would discard them.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 dark:bg-black/70 backdrop-blur-xs anim-fade-in">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Gemini API key settings"
        className="anim-panel-in card rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto overscroll-contain shadow-2xl"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
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
            aria-label="Close API key dialog"
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
              Gemini API Keys
            </label>
            <div className="space-y-2">
              {keyValues.map((key, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type={visibleKeys[index] ? 'text' : 'password'}
                      value={key}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.includes('\n') || val.includes(',')) {
                          const splitKeys = val.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
                          if (splitKeys.length > 1) {
                            setKeyValues((current) => {
                              const next = [...current];
                              next.splice(index, 1, ...splitKeys);
                              return next;
                            });
                            return;
                          }
                        }
                        setKeyValues((current) => current.map((item, i) => i === index ? val : item));
                      }}
                      placeholder="AIzaSy..."
                      spellCheck={false}
                      autoComplete="off"
                      data-autofocus={index === 0 ? true : undefined}
                      className="input pl-3 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-950 font-mono text-base sm:text-xs"
                      aria-label={`Gemini API key ${index + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => setVisibleKeys((current) => ({ ...current, [index]: !current[index] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1.5"
                      aria-label={visibleKeys[index] ? 'Hide API key' : 'Show API key'}
                    >
                      {visibleKeys[index] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setKeyValues((current) => current.length > 1 ? current.filter((_, i) => i !== index) : [''])}
                    className="p-2.5 min-h-[40px] min-w-[40px] rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition"
                    aria-label={`Remove API key ${index + 1}`}
                    title="Remove key"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setKeyValues((current) => [...current, ''])}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-mono transition"
              >
                <Plus className="w-3.5 h-3.5" />
                Add another key
              </button>
            </div>
          </div>

          {/* Storage Mode Choice */}
          <div className="space-y-1.5 pt-1">
            <label className="block text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
              Storage Preference:
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${!persistLocally ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30 text-zinc-900 dark:text-zinc-100' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}`}>
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

              <label className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${persistLocally ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30 text-zinc-900 dark:text-zinc-100' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}`}>
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

            {keyValues.some((key) => key.trim()) && (
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
              className="btn btn-secondary px-3.5 py-2 min-h-[44px] sm:min-h-[40px] text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary px-4 py-2 min-h-[44px] sm:min-h-[40px] text-xs"
            >
              Save Key
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
