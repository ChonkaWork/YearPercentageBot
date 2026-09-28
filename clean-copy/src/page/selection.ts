import type { Segment } from '../core/changes';
import { cleanCopy, type CleanStats } from '../core/cleaner';
import type { Original } from '../core/lastCopy';
import type { Rule } from '../core/rules';
import type { CleanOptions } from '../core/settings';
import { readOriginal } from './original';
import { snapshotSelection } from './reader';

export interface PageCleanResult {
  /** dom: a page selection; plain: a selection inside a text field; empty: nothing selected. */
  kind: 'dom' | 'plain' | 'empty';
  text: string;
  stats: CleanStats;
  truncated: boolean;
  /** What a normal copy would have given (for Undo). Null when too large to keep. */
  original?: Original | null;
  /** The annotated text for "Show changes" and the popup preview. */
  changes?: Segment[];
}

const NO_STATS: CleanStats = { invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0 };

/**
 * Reads the current selection (visible content only) and runs the Clean Copy pipeline on it.
 * With `withOriginal`, also keeps what a normal copy would have given (for Undo).
 */
export function cleanSelection(doc: Document, options: CleanOptions, rules: readonly Rule[] | null, withOriginal = true): PageCleanResult {
  const snapshot = snapshotSelection(doc);
  if (snapshot.kind === 'empty') return { kind: 'empty', text: '', stats: { ...NO_STATS }, truncated: false };
  const source = snapshot.kind === 'dom' ? { kind: 'dom' as const, nodes: snapshot.nodes, url: snapshot.url } : { kind: 'plain' as const, text: snapshot.text };
  const { text, stats, changes } = cleanCopy(source, options, rules, { track: true });
  const result: PageCleanResult = { kind: snapshot.kind, text, stats, truncated: snapshot.truncated };
  if (withOriginal) result.original = snapshot.truncated ? null : readOriginal(doc, snapshot.kind === 'plain' ? snapshot.text : null);
  if (changes) result.changes = changes;
  return result;
}
