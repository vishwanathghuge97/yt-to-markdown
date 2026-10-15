/**
 * Markdown helpers shared by the report generator and the preview renderer.
 * Both sides must produce identical heading slugs so the generated table of
 * contents actually navigates in the in-app preview (and on GitHub).
 */

/**
 * GitHub-compatible heading slug: lowercases, drops punctuation/emoji, and
 * converts every space to a hyphen ("Visual & On-Screen Notes" => "visual--on-screen-notes").
 */
export function slugifyHeading(text: string): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}
