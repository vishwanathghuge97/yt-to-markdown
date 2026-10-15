/**
 * Triggers a client-side download of a text payload (Markdown, JSON backups).
 */
export function downloadTextFile(
  fileName: string,
  content: string,
  mimeType = 'text/markdown;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
