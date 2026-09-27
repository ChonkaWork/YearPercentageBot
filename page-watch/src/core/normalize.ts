/** Snapshots are capped so a huge page can't fill chrome.storage. */
export const MAX_SNAPSHOT_CHARS = 100_000;

// Zero-width characters and the soft hyphen: invisible, but they differ between renders.
const INVISIBLE = /[​-‍⁠﻿­]/g;
// Every horizontal space variant (NBSP, thin spaces, ideographic space...) plus tabs.
const SPACES = /[ \t\f\v   -   　]+/g;

/**
 * Turns extracted text into a stable snapshot: one trimmed line per block, whitespace
 * collapsed, invisible characters and empty lines removed.
 */
export function normalizeText(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').split('\n')) {
    const clean = line.replace(SPACES, ' ').trim();
    if (clean) lines.push(clean);
  }
  return lines.join('\n');
}

/** Cuts text to the snapshot limit at a line boundary. */
export function capSnapshot(text: string, max = MAX_SNAPSHOT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return { text: lastBreak > max * 0.5 ? cut.slice(0, lastBreak) : cut, truncated: true };
}

export function splitLines(text: string): string[] {
  return text ? text.split('\n') : [];
}

/** Collapses whitespace for single-line use (keywords, table cells). */
export function collapseSpaces(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
