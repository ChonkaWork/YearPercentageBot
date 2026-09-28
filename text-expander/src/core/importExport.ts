/** JSON export and validated import (merge or replace). Pure functions. */

import { clipTags, hasErrors, LIMITS, normalizeDraft, sameTags, sortSnippets, validateFields, type Snippet, type SnippetDraft } from './snippets';

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
    snippets: sortSnippets(snippets).map(({ abbreviation, text, label, tags }) => (tags?.length ? { abbreviation, text, label, tags } : { abbreviation, text, label })),
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
    // A bad tag never costs the snippet.
    const tags = clipTags(draft.tags);
    if (tags.length) draft.tags = tags;
    else delete draft.tags;
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

export interface ImportOptions {
  /** How many snippets may exist afterwards (the plan's limit). */
  maxSnippets?: number;
  /** False on the free plan: imported tags are dropped, existing snippets keep theirs. */
  tags?: boolean;
}

/** The import would go over the plan's snippet limit. Nothing is written. */
export class ImportLimitError extends ImportError {
  override name = 'ImportLimitError';
  constructor(
    readonly total: number,
    readonly max: number,
  ) {
    super(`That would make ${total} snippets; ${max} is the limit.`);
  }
}

export interface ImportPlan {
  snippets: Snippet[];
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/**
 * Merge: new abbreviations are added, existing ones get the imported text and label (and the
 * imported tags, when the file has any).
 * Replace: the result is exactly the imported snippets.
 */
export function planImport(
  existing: readonly Snippet[],
  drafts: readonly SnippetDraft[],
  mode: ImportMode,
  createId: () => string,
  now: number,
  options: ImportOptions = {},
): ImportPlan {
  const max = options.maxSnippets ?? LIMITS.snippetsMax;
  const keepTags = options.tags ?? true;
  const withoutTags = ({ tags: _tags, ...rest }: SnippetDraft): SnippetDraft => rest;
  const create = (draft: SnippetDraft): Snippet => ({ id: createId(), ...(keepTags ? draft : withoutTags(draft)), createdAt: now, updatedAt: now });
  if (mode === 'replace') {
    if (drafts.length > max && max < LIMITS.snippetsMax) throw new ImportLimitError(drafts.length, max);
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
    } else if (current.text === draft.text && current.label === draft.label && (!keepTags || !draft.tags || sameTags(current.tags, draft.tags))) {
      unchanged++;
    } else {
      const next: Snippet = { ...current, text: draft.text, label: draft.label, updatedAt: now };
      // Merging never removes tags: a file without tags (older exports) keeps the current ones.
      if (keepTags && draft.tags?.length) next.tags = draft.tags;
      snippets[snippets.indexOf(current)] = next;
      updated++;
    }
  }
  // Only new snippets count against the plan: an import never takes away what exists.
  if (added > 0 && snippets.length > max && max < LIMITS.snippetsMax) throw new ImportLimitError(snippets.length, max);
  if (snippets.length > LIMITS.snippetsMax) {
    throw new ImportError(`That would make ${snippets.length} snippets; ${LIMITS.snippetsMax} is the limit. Try "Replace" or remove some first.`);
  }
  return { snippets, added, updated, unchanged, removed: 0 };
}
