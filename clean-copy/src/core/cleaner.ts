import { startTracking, track, type Segment, type Tracker } from './changes';
import { markdownStep } from './markdown';
import { toPlainText } from './plainText';
import { applyRules, type Rule, type RuleRunOptions, type RuleStop } from './rules';
import type { CleanOptions } from './settings';
import { isElement, type SnapNode } from './snapshot';
import { collapseSpacesStep, invisibleStep, mergeLinesStep, stripBulletsStep, tidyStep, trailingSpaceStep } from './steps';
import { countInvisible, normalizeSpaces } from './text';
import { typographyStep } from './typography';
import { stripTrackingStep } from './urls';

export { isListLine } from './steps';

/**
 * The Clean Copy pipeline. Input is either a snapshot of the selected DOM (what the page
 * shows: hidden elements, fonts, colors and links already gone) or plain text (text fields,
 * text another script put on the clipboard, pages Chrome doesn't let extensions read).
 *
 *   text → invisible characters → Markdown → typography → collapse spaces → merge lines
 *        → bullets → tidy → tracking parameters → custom rules → tidy
 *
 * Every step reports its edits, so the result can also say exactly what changed ("Show
 * changes"). Pure: no DOM, no Chrome APIs.
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
  /** Quotes, dashes, ellipses and spaces made plain (typography option). */
  typography?: number;
  /** Markdown constructs removed (Markdown option). */
  markdown?: number;
}

export interface CleanResult {
  text: string;
  stats: CleanStats;
  /** The annotated text for "Show changes" (with `track`, and only for texts up to TRACK_LIMIT). */
  changes?: Segment[];
}

export interface CleanRunOptions extends RuleRunOptions {
  /** Report what changed as annotated text. */
  track?: boolean;
}

/** Longest text (in characters) whose changes are tracked; longer copies are cleaned the same way. */
export const TRACK_LIMIT = 200_000;

export function cleanCopy(source: CleanSource, options: CleanOptions, rules: readonly Rule[] | null = null, run: CleanRunOptions = {}): CleanResult {
  const stats: CleanStats = { invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0 };
  let t: Tracker;
  if (source.kind === 'dom') {
    stats.invisible = countInvisibleInNodes(source.nodes);
    const plainOptions = { pageUrl: source.url, includeLinkUrls: options.keepLinkUrls };
    const text = toPlainText(source.nodes, plainOptions);
    t = startTracking(text, Boolean(run.track) && text.length <= TRACK_LIMIT);
    if (t.segments && stats.invisible > 0) {
      // Convert once more with the invisible characters kept, so their removal can be shown.
      // Used only when removing them gives exactly the same text.
      const kept = toPlainText(source.nodes, { ...plainOptions, keepInvisible: true });
      const step = invisibleStep(kept);
      if (step.text === text) t = track(startTracking(kept, true), step, 'invisible');
    }
  } else {
    stats.invisible = countInvisible(source.text);
    const text = normalizeSpaces(source.text.replace(/\r\n?/g, '\n'));
    t = startTracking(text, Boolean(run.track) && text.length <= TRACK_LIMIT);
    t = track(t, invisibleStep(t.text), 'invisible');
    t = track(t, trailingSpaceStep(t.text), 'whitespace');
    t = track(t, tidyStep(t.text), 'whitespace');
  }

  if (options.removeMarkdown) {
    const step = markdownStep(t.text);
    stats.markdown = step.count;
    t = track(t, step, 'markdown');
  }
  if (options.typography) {
    const step = typographyStep(t.text, options.dashes);
    stats.typography = step.count;
    t = track(t, step, 'typography');
  }
  if (options.collapseWhitespace) t = track(t, collapseSpacesStep(t.text), 'whitespace');
  if (options.lineBreaks === 'merge') t = track(t, mergeLinesStep(t.text), 'line-break');
  if (!options.keepBullets) t = track(t, stripBulletsStep(t.text), 'bullet');
  t = track(t, tidyStep(t.text), 'whitespace');
  if (options.stripTracking) {
    const step = stripTrackingStep(t.text);
    stats.trackingParams = step.removed;
    t = track(t, step, 'tracking');
  }

  if (rules && rules.length > 0) {
    const result = applyRules(t.text, rules, { ...run, track: Boolean(t.segments) });
    if (t.segments && result.edits) {
      // One step per rule, in order: each rule's edits refer to the text before it.
      let current = t.text;
      for (const edits of result.edits) {
        const next = applyRuleEdits(current, edits);
        t = track(t, { text: next, edits }, 'rule');
        current = next;
      }
    }
    t = track(t, { text: result.text, edits: [] }, 'rule');
    // Rules that delete lines leave blank lines behind: tidy the edges and gaps again.
    t = track(t, tidyStep(t.text), 'whitespace');
    stats.replacements = result.replacements;
    stats.rulesApplied = result.rulesApplied;
    if (result.stopped) stats.rulesStopped = result.stopped;
  }
  const out: CleanResult = { text: t.text, stats };
  if (t.segments) out.changes = t.segments;
  return out;
}

function applyRuleEdits(text: string, edits: readonly { start: number; end: number; insert?: string }[]): string {
  let out = '';
  let last = 0;
  for (const edit of edits) {
    out += text.slice(last, edit.start) + (edit.insert ?? '');
    last = edit.end;
  }
  return out + text.slice(last);
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

// --- Steps (text only; exported for tests and the settings example) --------------------------

/**
 * Runs of spaces inside a line become one space and trailing spaces go. Indentation at the
 * start of a line (nested lists, code) and tabs (they separate table cells) are kept.
 * Lines holding only whitespace become empty.
 */
export function collapseSpaces(text: string): string {
  return collapseSpacesStep(text).text;
}

/**
 * Joins wrapped lines into flowing paragraphs. Blank lines still separate paragraphs, list
 * items and table rows (lines with tabs) stay on their own lines, and a word hyphenated at
 * the end of a line ("exam-\nple") is joined back ("example").
 */
export function mergeLines(text: string): string {
  return mergeLinesStep(text).text;
}

/** Removes bullet markers and list indentation; numbered items keep their numbers. */
export function stripBullets(text: string): string {
  return stripBulletsStep(text).text;
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
  if (stats.markdown) removed.push(count(stats.markdown, 'Markdown mark'));
  const parts = [count(length, 'character')];
  if (removed.length) parts.push(`removed ${removed.slice(0, -1).join(', ')}${removed.length > 1 ? ' and ' : ''}${removed[removed.length - 1]}`);
  if (stats.typography) parts.push(`${stats.typography.toLocaleString('en-US')} typography ${stats.typography === 1 ? 'fix' : 'fixes'}`);
  if (stats.rulesApplied > 0) parts.push(`${count(stats.rulesApplied, 'rule')} applied`);
  if (stats.rulesStopped) parts.push('some rules skipped (limit reached)');
  return parts.join(' · ');
}
