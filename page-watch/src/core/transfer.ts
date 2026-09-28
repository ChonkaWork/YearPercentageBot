import { parseTarget } from './numbers';
import { canAddWatch, isIntervalAllowed, isRuleAllowed, limitsFor, type Plan } from './plan';
import { INTERVALS, isChangeMode, isInterval, type ChangeMode, type IntervalMinutes, type Watch } from './types';
import { hostLabel, normalizeWatchUrl, originPattern } from './url';
import { cleanKeyword, cleanName, cleanTarget, MAX_SELECTOR_CHARS, MAX_WATCHES } from './watch';

/**
 * Export and import of watches as a JSON file (settings only: page, element, rule, interval).
 * Imported watches take their first check as the baseline, like a new watch.
 */

export const EXPORT_FORMAT = 'page-watch';
export const EXPORT_VERSION = 1;
/** Larger files are refused before parsing. */
export const MAX_IMPORT_BYTES = 2_000_000;

export interface ExportedWatch {
  url: string;
  name: string;
  /** CSS selector of the watched element, or null for the whole page. */
  selector: string | null;
  intervalMinutes: IntervalMinutes;
  mode: ChangeMode;
  keyword: string;
  target: string;
  paused: boolean;
  sound: boolean;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  watches: ExportedWatch[];
}

export function exportWatches(watches: readonly Watch[], now: number): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    watches: watches.map((watch) => ({
      url: watch.url,
      name: watch.name,
      selector: watch.selector,
      intervalMinutes: watch.intervalMinutes,
      mode: watch.mode,
      keyword: watch.keyword,
      target: watch.target,
      paused: watch.paused,
      sound: watch.sound,
    })),
  };
}

/** "page-watch-2026-09-28.json" (local date). */
export function exportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `page-watch-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

export interface ImportIssue {
  /** Position in the file, from 1. */
  entry: number;
  reason: string;
}

export type ParsedImport = { ok: true; watches: ExportedWatch[]; invalid: ImportIssue[] } | { ok: false; message: string };

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One entry of an import file, cleaned like a watch added by hand. */
export function validateImported(raw: unknown): { ok: true; value: ExportedWatch } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not a watch' };
  const url = normalizeWatchUrl(raw.url);
  if (!url) return { ok: false, reason: 'the address is not a web page (http or https)' };
  const selector = raw.selector === null || raw.selector === undefined ? null : typeof raw.selector === 'string' ? raw.selector.trim() : undefined;
  if (selector === undefined || (selector !== null && (!selector || selector.length > MAX_SELECTOR_CHARS))) return { ok: false, reason: 'the element selector is not valid' };
  const intervalMinutes = raw.intervalMinutes === undefined ? 60 : raw.intervalMinutes;
  if (!isInterval(intervalMinutes)) return { ok: false, reason: `the interval must be one of ${INTERVALS.join(', ')} minutes` };
  const mode = raw.mode === undefined ? 'text' : raw.mode;
  if (!isChangeMode(mode)) return { ok: false, reason: 'unknown rule' };
  const keyword = cleanKeyword(raw.keyword);
  if (mode === 'keyword' && !keyword) return { ok: false, reason: 'the keyword rule has no keyword' };
  const target = cleanTarget(raw.target);
  if (mode === 'below' && !parseTarget(target)) return { ok: false, reason: 'the price rule has no valid target price' };
  return {
    ok: true,
    value: {
      url,
      name: cleanName(raw.name) || hostLabel(url),
      selector,
      intervalMinutes,
      mode,
      keyword: mode === 'keyword' ? keyword : '',
      target: mode === 'below' ? target : '',
      paused: raw.paused === true,
      sound: raw.sound !== false,
    },
  };
}

/** Reads an import file: a Page Watch export, or just an array of watches. */
export function parseImportFile(text: string): ParsedImport {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, message: 'This file is too large to be a Page Watch export (over 2 MB).' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file isn't valid JSON. Choose a file exported from Page Watch." };
  }
  let entries: unknown;
  if (Array.isArray(data)) entries = data;
  else if (isRecord(data) && data.format === EXPORT_FORMAT) {
    if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
      return { ok: false, message: 'This file comes from a newer version of Page Watch. Update Page Watch, then import it again.' };
    }
    entries = data.watches;
  } else {
    return { ok: false, message: "This file isn't a Page Watch export." };
  }
  if (!Array.isArray(entries)) return { ok: false, message: "This file isn't a Page Watch export." };
  const watches: ExportedWatch[] = [];
  const invalid: ImportIssue[] = [];
  entries.slice(0, MAX_WATCHES * 2).forEach((entry, index) => {
    const result = validateImported(entry);
    if (result.ok) watches.push(result.value);
    else invalid.push({ entry: index + 1, reason: result.reason });
  });
  if (entries.length > MAX_WATCHES * 2) invalid.push({ entry: MAX_WATCHES * 2 + 1, reason: `only the first ${MAX_WATCHES * 2} entries are read` });
  return { ok: true, watches, invalid };
}

export interface ImportPlan {
  /** Watches to add, set to what the plan allows. */
  add: ExportedWatch[];
  /** Already watched (same page and element), or twice in the file. */
  duplicates: number;
  /** Set to what the plan allows (rule or interval). */
  adapted: number;
  /** Left out because of the watch limit. */
  overLimit: number;
  /** Site access the new watches need ("https://shop.example.com/*"). */
  origins: string[];
}

const key = (watch: { url: string; selector: string | null }) => `${watch.url}\u0000${watch.selector ?? ''}`;

/** What importing these would do: duplicates left out, Pro settings set to free ones on free, the limit applied. */
export function planImport(entries: readonly ExportedWatch[], existing: readonly Watch[], plan: Plan): ImportPlan {
  const seen = new Set(existing.map(key));
  const add: ExportedWatch[] = [];
  let duplicates = 0;
  let adapted = 0;
  let overLimit = 0;
  const minimum = INTERVALS.find((minutes) => isIntervalAllowed(plan, minutes)) ?? 60;
  for (const entry of entries) {
    if (seen.has(key(entry))) {
      duplicates++;
      continue;
    }
    seen.add(key(entry));
    if (!canAddWatch(plan, existing.length + add.length) || existing.length + add.length >= MAX_WATCHES) {
      overLimit++;
      continue;
    }
    let watch = entry;
    if (!isRuleAllowed(plan, watch.mode) || !isIntervalAllowed(plan, watch.intervalMinutes)) {
      adapted++;
      watch = isRuleAllowed(plan, watch.mode) ? { ...watch } : { ...watch, mode: 'text', keyword: '', target: '' };
      if (!isIntervalAllowed(plan, watch.intervalMinutes)) watch.intervalMinutes = minimum;
    }
    add.push(watch);
  }
  const origins = [...new Set(add.map((watch) => originPattern(watch.url)))].sort();
  return { add, duplicates, adapted, overLimit, origins };
}

export interface ImportResult {
  added: number;
  duplicates: number;
  adapted: number;
  overLimit: number;
  invalid: number;
  /** Left out because access to their site wasn't granted. */
  noAccess: number;
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** "Added 3 watches. 2 were already watched. …" */
export function importSummary(result: ImportResult, plan: Plan): string {
  const parts: string[] = [result.added ? `Added ${count(result.added, 'watch', 'watches')}.` : 'No watches were added.'];
  if (result.duplicates) parts.push(`${count(result.duplicates, 'was', 'were')} already watched.`);
  if (result.adapted) {
    parts.push(`${count(result.adapted, 'was', 'were')} set to free options (any text change, every hour or slower): ${result.adapted === 1 ? 'its rule or interval is' : 'their rules or intervals are'} part of Pro.`);
  }
  if (result.overLimit) {
    const limit = Number.isFinite(limitsFor(plan).maxWatches) ? 'the free plan keeps 3 watches' : `Page Watch keeps up to ${MAX_WATCHES} watches`;
    parts.push(`${count(result.overLimit, 'was', 'were')} left out: ${limit}.`);
  }
  if (result.noAccess) parts.push(`${count(result.noAccess, 'was', 'were')} left out: Page Watch wasn't allowed to access ${result.noAccess === 1 ? 'its site' : 'their sites'}.`);
  if (result.invalid) parts.push(`${count(result.invalid, "entry wasn't", "entries weren't")} a valid watch.`);
  return parts.join(' ');
}
