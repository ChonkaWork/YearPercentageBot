/**
 * Saves bytes as a file through an <a download> link: no `downloads` permission needed.
 * Works from extension pages (the popup, options).
 */
export function downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download; the popup closing revokes it anyway.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
