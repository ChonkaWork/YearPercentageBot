import { checkError } from './errors';
import type { CheckError } from './types';

/**
 * Decisions made when a watch is created: which selector candidate to keep and whether
 * the page only shows its content after JavaScript runs (which background checks can't see).
 */

export interface CandidateResult {
  selector: string;
  /** Elements the selector matched in the fetched HTML. */
  matchCount: number;
  /** Text of the first match, null when nothing matched. */
  text: string | null;
  /** The text was cut to the snapshot limit. */
  truncated: boolean;
}

export interface ExtractedText {
  text: string;
  truncated: boolean;
}

export type Baseline =
  | { ok: true; selector: string | null; text: string; truncated: boolean }
  | { ok: false; error: CheckError };

/** Below this, a whole page counts as nearly empty. */
export const NEARLY_EMPTY_CHARS = 50;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Word-set overlap (Jaccard), 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

const NOT_SUPPORTED =
  "Page Watch checks pages without running their scripts, so it can't see it. Watching this isn't supported yet: try a part that's there when the page first loads, or the whole page.";
const JS_ELEMENT_MISSING = `The part you picked isn't in the page's HTML: this page renders it with JavaScript. ${NOT_SUPPORTED}`;
const JS_ELEMENT_DIFFERENT = `The part you picked shows different content in the page's HTML: this page renders it with JavaScript. ${NOT_SUPPORTED}`;

/**
 * Element watches: keep the most robust candidate that finds the same content in the
 * fetched HTML as the user saw on screen.
 */
export function chooseElementBaseline(liveText: string | null, results: readonly CandidateResult[]): Baseline {
  const matched = results.filter((result): result is CandidateResult & { text: string } => result.text !== null);
  if (matched.length === 0) return { ok: false, error: { ...checkError('js-rendered'), message: JS_ELEMENT_MISSING } };

  const live = liveText ?? '';
  const exact = matched.find((result) => result.text === live);
  if (exact || !live) {
    const pick = exact ?? matched[0]!;
    return { ok: true, selector: pick.selector, text: pick.text, truncated: pick.truncated };
  }

  let best = matched[0]!;
  let bestScore = -1;
  for (const result of matched) {
    const score = similarity(live, result.text);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  if (!best.text || bestScore === 0) {
    return { ok: false, error: { ...checkError('js-rendered'), message: best.text ? JS_ELEMENT_DIFFERENT : JS_ELEMENT_MISSING } };
  }
  return { ok: true, selector: best.selector, text: best.text, truncated: best.truncated };
}

/**
 * Whole-page watches: refuse pages whose HTML is (nearly) empty while the tab shows content,
 * or that only ship a thin shell around JavaScript-rendered content.
 */
export function choosePageBaseline(liveText: string | null, page: ExtractedText): Baseline {
  const fetched = page.text.length;
  const live = liveText?.length ?? null;
  if (live !== null) {
    const nearlyEmpty = fetched < NEARLY_EMPTY_CHARS && live > fetched * 2 + 100;
    const thinShell = live >= 500 && fetched < live * 0.1;
    if (nearlyEmpty || thinShell) return { ok: false, error: checkError('js-rendered') };
  }
  if (fetched === 0) {
    return { ok: false, error: { ...checkError('empty'), message: "This page doesn't have any text to watch." } };
  }
  return { ok: true, selector: null, text: page.text, truncated: page.truncated };
}

/**
 * Later checks of whole-page watches: a page that collapses to almost nothing is far more
 * likely a bot wall or a switch to client-side rendering than a real change.
 */
export function looksCollapsed(previousText: string, nextText: string): boolean {
  if (nextText.length === 0) return true;
  return previousText.length >= 500 && nextText.length < Math.max(NEARLY_EMPTY_CHARS, previousText.length * 0.05);
}
