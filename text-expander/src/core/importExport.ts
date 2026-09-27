/** JSON export and validated import (merge or replace). Pure functions. */

import { hasErrors, LIMITS, normalizeDraft, sortSnippets, validateFields, type Snippet, type SnippetDraft } from './snippets';

export const EXPORT_FORMAT = 'snippets-text-expander';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  snippets: SnippetDraft[];
}

export function buildExport(snippets: readonly Snippet[], now: Date): string {
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    snippets: sortSnippets(snippets).map(({ abbreviation, text, label }) => ({ abbreviation, text, label })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function exportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `snippets-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

export interface SkippedItem {
  /** 1-based position in the file. */
  position: number;
  abbreviation: string;
  reason: string;
}

export interface ParsedImport {
  drafts: SnippetDraft[];
  skipped: SkippedItem[];
}

export class ImportError extends Error {
  override name = 'ImportError';
}

/**
 * Accepts a Snippets export (`{ snippets: [...] }`) or a bare array of
 * `{ abbreviation, text, label? }`. Throws ImportError when the file as a whole is unusable;
 * individual bad entries are reported in `skipped`.
 */
export function parseImport(json: string): ParsedImport {
  if (json.length > MAX_IMPORT_BYTES) throw new ImportError('This file is too large (5 MB at most).');
  let data: unknown;
  try {
    data = JSON.parse(json.replace(/^﻿/, ''));
  } catch {
    throw new ImportError("This file isn't valid JSON.");
  }
  let items: unknown;
  if (Array.isArray(data)) items = data;
  else if (typeof data === 'object' && data !== null && 'snippets' in data) items = (data as { snippets: unknown }).snippets;
  if (!Array.isArray(items)) throw new ImportError('No snippets found. Expected a Snippets export or a list of { "abbreviation", "text" } objects.');
  if (items.length === 0) throw new ImportError('This file contains no snippets.');
  if (items.length > LIMITS.snippetsMax) throw new ImportError(`This file has ${items.length} snippets; ${LIMITS.snippetsMax} is the limit.`);

  const drafts: SnippetDraft[] = [];
  const skipped: SkippedItem[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const position = index + 1;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      skipped.push({ position, abbreviation: '', reason: 'Not a snippet object.' });
      return;
    }
    const draft = normalizeDraft(item as Record<string, unknown>);
    const errors = validateFields(draft);
    if (hasErrors(errors)) {
      skipped.push({ position, abbreviation: draft.abbreviation, reason: errors.abbreviation ?? errors.text ?? errors.label ?? 'Invalid.' });
      return;
    }
    if (seen.has(draft.abbreviation)) {
      skipped.push({ position, abbreviation: draft.abbreviation, reason: 'Duplicate abbreviation in this file.' });
      return;
    }
    seen.add(draft.abbreviation);
    drafts.push(draft);
  });
  if (drafts.length === 0) throw new ImportError(`None of the ${items.length} entries is a valid snippet.`);
  return { drafts, skipped };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportPlan {
  snippets: Snippet[];
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/**
 * Merge: new abbreviations are added, existing ones get the imported text and label.
 * Replace: the result is exactly the imported snippets.
 */
export function planImport(
  existing: readonly Snippet[],
  drafts: readonly SnippetDraft[],
  mode: ImportMode,
  createId: () => string,
  now: number,
): ImportPlan {
  const create = (draft: SnippetDraft): Snippet => ({ id: createId(), ...draft, createdAt: now, updatedAt: now });
  if (mode === 'replace') {
    return { snippets: drafts.map(create), added: drafts.length, updated: 0, unchanged: 0, removed: existing.length };
  }
  const byAbbreviation = new Map(existing.map((snippet) => [snippet.abbreviation, snippet]));
  const snippets = [...existing];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const draft of drafts) {
    const current = byAbbreviation.get(draft.abbreviation);
    if (!current) {
      snippets.push(create(draft));
      added++;
    } else if (current.text === draft.text && current.label === draft.label) {
      unchanged++;
    } else {
      snippets[snippets.indexOf(current)] = { ...current, text: draft.text, label: draft.label, updatedAt: now };
      updated++;
    }
  }
  if (snippets.length > LIMITS.snippetsMax) {
    throw new ImportError(`That would make ${snippets.length} snippets; ${LIMITS.snippetsMax} is the limit. Try "Replace" or remove some first.`);
  }
  return { snippets, added, updated, unchanged, removed: 0 };
}
