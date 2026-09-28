import { cleanCopy, type CleanStats } from '../core/cleaner';
import type { Rule } from '../core/rules';
import type { CleanOptions } from '../core/settings';
import { snapshotSelection } from './reader';

export interface PageCleanResult {
  /** dom: a page selection; plain: a selection inside a text field; empty: nothing selected. */
  kind: 'dom' | 'plain' | 'empty';
  text: string;
  stats: CleanStats;
  truncated: boolean;
}

const NO_STATS: CleanStats = { invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0 };

/** Reads the current selection (visible content only) and runs the Clean Copy pipeline on it. */
export function cleanSelection(doc: Document, options: CleanOptions, rules: readonly Rule[] | null): PageCleanResult {
  const snapshot = snapshotSelection(doc);
  if (snapshot.kind === 'empty') return { kind: 'empty', text: '', stats: { ...NO_STATS }, truncated: false };
  const source = snapshot.kind === 'dom' ? { kind: 'dom' as const, nodes: snapshot.nodes, url: snapshot.url } : { kind: 'plain' as const, text: snapshot.text };
  const { text, stats } = cleanCopy(source, options, rules);
  return { kind: snapshot.kind, text, stats, truncated: snapshot.truncated };
}
