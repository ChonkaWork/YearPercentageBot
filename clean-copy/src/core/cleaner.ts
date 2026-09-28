import { toPlainText } from './plainText';
import { applyRules, type Rule, type RuleRunOptions, type RuleStop } from './rules';
import type { CleanOptions } from './settings';
import { isElement, type SnapNode } from './snapshot';
import { countInvisible, normalizePlainText, tidyText } from './text';
import { stripTrackingParams } from './urls';

/**
 * The Clean Copy pipeline. Input is either a snapshot of the selected DOM (what the page
 * shows: hidden elements, fonts, colors and links already gone) or plain text (text fields,
 * text another script put on the clipboard, pages Chrome doesn't let extensions read).
 *
 *   text → collapse spaces → merge lines → bullets → tracking parameters → custom rules → tidy
 *
 * Pure: no DOM, no Chrome APIs.
 */

export type CleanSource = { kind: 'dom'; nodes: readonly SnapNode[]; url?: string } | { kind: 'plain'; text: string };

export interface CleanStats {
  /** Zero-width spaces, BOMs, soft hyphens and similar characters removed. */
  invisible: number;
  /** Tracking parameters removed from web addresses. */
  trackingParams: number;
  /** Custom rules: replacements made and rules that changed the text. */
  replacements: number;
  rulesApplied: number;
  /** A custom-rule limit stopped the rules early. */
  rulesStopped?: RuleStop;
}

export interface CleanResult {
  text: string;
  stats: CleanStats;
}

export function cleanCopy(source: CleanSource, options: CleanOptions, rules: readonly Rule[] | null = null, run: RuleRunOptions = {}): CleanResult {
  const stats: CleanStats = { invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0 };
  let text: string;
  if (source.kind === 'dom') {
    stats.invisible = countInvisibleInNodes(source.nodes);
    text = toPlainText(source.nodes, { pageUrl: source.url });
  } else {
    stats.invisible = countInvisible(source.text);
    text = normalizePlainText(source.text);
  }

  if (options.collapseWhitespace) text = collapseSpaces(text);
  if (options.lineBreaks === 'merge') text = mergeLines(text);
  if (!options.keepBullets) text = stripBullets(text);
  text = tidyText(text);
  if (options.stripTracking) {
    const stripped = stripTrackingParams(text);
    text = stripped.text;
    stats.trackingParams = stripped.removed;
  }

  if (rules && rules.length > 0) {
    const result = applyRules(text, rules, run);
    // Rules that delete lines leave blank lines behind: tidy the edges and gaps again.
    text = tidyText(result.text);
    stats.replacements = result.replacements;
    stats.rulesApplied = result.rulesApplied;
    if (result.stopped) stats.rulesStopped = result.stopped;
  }
  return { text, stats };
}

function countInvisibleInNodes(nodes: readonly SnapNode[]): number {
  let count = 0;
  const walk = (list: readonly SnapNode[]) => {
    for (const node of list) {
      if (isElement(node)) walk(node.c);
      else count += countInvisible(node.v);
    }
  };
  walk(nodes);
  return count;
}

// --- Steps (exported for tests) ---------------------------------------------------------------

/** A list line: "- item", "• item", "* item", "1. item", "2) item", with any indentation. */
const LIST_LINE = /^[ \t]*(?:[-*•◦▪‣–·]|\d{1,3}[.)])[ \t]+\S/;
const BULLET = /^[ \t]*[-*•◦▪‣–·][ \t]+/;
const NUMBERED = /^[ \t]*(\d{1,3}[.)][ \t]+)/;

export function isListLine(line: string): boolean {
  return LIST_LINE.test(line);
}

/**
 * Runs of spaces inside a line become one space and trailing spaces go. Indentation at the
 * start of a line (nested lists, code) and tabs (they separate table cells) are kept.
 * Lines holding only whitespace become empty.
 */
export function collapseSpaces(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return indent + line.slice(indent.length).replace(/ {2,}/g, ' ').replace(/ +(?=\t)|(?<=\t) +/g, '').trimEnd();
    })
    .join('\n');
}

/**
 * Joins wrapped lines into flowing paragraphs. Blank lines still separate paragraphs, list
 * items and table rows (lines with tabs) stay on their own lines, and a word hyphenated at
 * the end of a line ("exam-\nple") is joined back ("example").
 */
export function mergeLines(text: string): string {
  const out: string[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      out.push('');
      open = false;
      continue;
    }
    const table = line.includes('\t');
    const previous = out[out.length - 1];
    if (!open || previous === undefined || isListLine(line) || table || previous.includes('\t')) {
      out.push(line);
      open = !table;
      continue;
    }
    const next = line.trim();
    const joined = /\p{Ll}-$/u.test(previous) && /^\p{Ll}/u.test(next) ? previous.slice(0, -1) + next : `${previous.trimEnd()} ${next}`;
    out[out.length - 1] = joined;
  }
  return out.join('\n');
}

/** Removes bullet markers and list indentation; numbered items keep their numbers. */
export function stripBullets(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!isListLine(line)) return line;
      if (BULLET.test(line)) return line.replace(BULLET, '');
      return line.replace(NUMBERED, '$1');
    })
    .join('\n');
}

// --- Summary --------------------------------------------------------------------------------

function count(value: number, word: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? word : `${word}s`}`;
}

/** One line for the toast and the popup: what the cleanup did besides dropping formatting. */
export function describeClean(stats: CleanStats, length: number): string {
  const removed: string[] = [];
  if (stats.trackingParams > 0) removed.push(count(stats.trackingParams, 'tracking parameter'));
  if (stats.invisible > 0) removed.push(count(stats.invisible, 'invisible character'));
  const parts = [count(length, 'character')];
  if (removed.length) parts.push(`removed ${removed.join(' and ')}`);
  if (stats.rulesApplied > 0) parts.push(`${count(stats.rulesApplied, 'rule')} applied`);
  if (stats.rulesStopped) parts.push('some rules skipped (limit reached)');
  return parts.join(' · ');
}
