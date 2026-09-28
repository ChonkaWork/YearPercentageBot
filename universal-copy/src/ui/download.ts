import type { DownloadFile } from '../core/download';

/**
 * Saves a file from an extension page through a Blob URL and an `<a download>` click, so
 * no `downloads` permission is needed. Chrome takes over the Blob when the download
 * starts; the URL is released a minute later (or when the popup closes).
 */
export function saveFile(file: DownloadFile, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
