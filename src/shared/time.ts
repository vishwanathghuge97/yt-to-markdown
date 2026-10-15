/**
 * Shared timestamp formatting for transcripts, chapters, and model prompts.
 * Guards against negative or non-finite values coming from model output.
 */

/**
 * Formats seconds as HH:MM:SS (when `alwaysHours` is true or the duration reaches
 * an hour) or MM:SS otherwise. Negative/NaN inputs are clamped to 00:00.
 */
export function formatTimestamp(seconds: number, alwaysHours = false): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (alwaysHours || hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
