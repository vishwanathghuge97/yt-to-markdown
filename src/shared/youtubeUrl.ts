/**
 * Shared YouTube URL parsing used by both the browser app and the server API.
 * Keeping a single implementation prevents the client/server validators from drifting apart.
 */

/**
 * Strict YouTube video ID extractor & validator.
 * Handles watch, embed, shorts, live, youtu.be, music, mobile, and raw-ID formats.
 */
export function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  let trimmed = input.trim();

  // Strip enclosing quotes, markdown angle brackets <...>, or extra whitespace
  trimmed = trimmed.replace(/^[<"'\s]+|[>"'\s]+$/g, '');

  // Decode URI component if pasted as an encoded string
  if (trimmed.includes('%3A') || trimmed.includes('%2F')) {
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch {}
  }

  // Direct 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(
    /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|e\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  return match ? match[1] : null;
}

/**
 * Returns a canonical https://www.youtube.com/watch?v=... URL for any supported input,
 * or the trimmed original when no video ID can be extracted.
 */
export function getCanonicalYouTubeUrl(input: string): string {
  const id = extractYouTubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : input.trim();
}
