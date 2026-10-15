import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * "Copied ✓" button feedback: returns `copied` plus a `flashCopied()` trigger.
 * Uses a single timer that is replaced on repeat calls and cleared on unmount
 * (avoids stray setState-after-unmount timers).
 */
export function useCopiedFlag(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, resetAfterMs);
  }, [resetAfterMs]);

  return { copied, flashCopied };
}
