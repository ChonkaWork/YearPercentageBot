/**
 * Decoding fetched pages. `Response.text()` always assumes UTF-8, which garbles pages served
 * in legacy encodings (windows-1251, Shift_JIS...), so the charset is resolved like a browser
 * would: BOM, then the Content-Type header, then a <meta> tag near the top.
 */

export type ContentKind = 'html' | 'text' | 'unknown' | 'other';

export function mimeOf(contentType: string | null): string {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

export function contentKind(contentType: string | null): ContentKind {
  const mime = mimeOf(contentType);
  if (!mime) return 'unknown';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/plain') return 'text';
  return 'other';
}

/** For responses without a Content-Type: does the start of the body look like HTML? */
export function looksLikeHtml(start: string): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|meta|title|div|p)\b/i.test(start);
}

export function charsetFromContentType(contentType: string | null): string | null {
  const match = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '');
  return match ? match[1]!.toLowerCase() : null;
}

/** Looks for <meta charset> or <meta http-equiv="Content-Type" content="...charset=..."> in the first bytes. */
export function sniffMetaCharset(head: string): string | null {
  const direct = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return direct ? direct[1]!.toLowerCase() : null;
}

export function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return null;
}

function supported(label: string | null): string | null {
  if (!label) return null;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/** Decodes a response body with the right charset (UTF-8 when nothing else is known). */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromBom = supported(bomCharset(bytes));
  const fromHeader = supported(charsetFromContentType(contentType));
  let fromMeta = contentKind(contentType) === 'text' ? null : supported(sniffMetaCharset(head));
  // A <meta> tag can't really declare UTF-16 (it's readable as ASCII), browsers use UTF-8 then.
  if (fromMeta?.startsWith('utf-16')) fromMeta = 'utf-8';
  return new TextDecoder(fromBom ?? fromHeader ?? fromMeta ?? 'utf-8').decode(bytes);
}
