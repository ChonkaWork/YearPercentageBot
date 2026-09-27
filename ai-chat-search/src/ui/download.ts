/**
 * Saves text as a file through an `<a download>` click, so no `downloads` permission is needed.
 * In the content script the link lives in our shadow root and stops the click there, so the
 * chat site's own link handling (SPA routers) never sees it.
 */
export function downloadText(filename: string, content: string, mime: string, container: ParentNode = document.body): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  link.addEventListener('click', (event) => event.stopPropagation());
  container.append(link);
  link.click();
  link.remove();
  // The download has started by now; keep the URL around a little for slow disks.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
