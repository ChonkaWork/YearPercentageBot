import { diffLines, diffStats, toHunks, type DiffOp } from './diff';
import { newLow, readValue, type NewLow, type ValuePoint } from './history';
import { annotateOps, maskText, type NoiseRule } from './noise';
import { collapseSpaces, splitLines } from './normalize';
import { extractNumbers, findPrice, parseTarget, sameNumbers, type NumberToken, type Price } from './numbers';
import type { ChangeMode, DiffLine } from './types';

export interface ChangeRule {
  mode: ChangeMode;
  keyword: string;
  /** Target price for `below` mode, as typed. */
  target?: string;
}

export interface EvaluateContext {
  /** Noise rules of the watch: what they explain doesn't count as a change. */
  noise?: readonly NoiseRule[];
  /** Values seen by earlier checks, for `lowest` mode. */
  history?: readonly ValuePoint[];
  now?: number;
}

export interface Evaluation {
  /** Whether this counts as a change under the watch's rule (and should notify). */
  changed: boolean;
  summary: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
  /** Ids of the noise rules that explained part of the difference. */
  fired: string[];
  /** Only lines the noise filter ignores changed. */
  noiseOnly?: boolean;
}

const MINUS = '−';
export const NOISE_ONLY_SUMMARY = 'Only ignored lines changed';

/**
 * Compares two snapshots under a watch's rule. Returns null when the text is identical.
 * The diff is always computed so the viewer can show what moved, even in number and
 * keyword modes. Noise rules mask what they explain before the rule looks at the text; the
 * diff keeps those lines, marked as ignored.
 */
export function evaluateChange(prevText: string, nextText: string, rule: ChangeRule, context: EvaluateContext = {}): Evaluation | null {
  if (prevText === nextText) return null;
  const noise = context.noise ?? [];
  const before = splitLines(prevText);
  const after = splitLines(nextText);
  const annotated = annotateOps(diffLines(before, after), before, after, noise);
  const ops = annotated.ops;
  const real = noise.length ? ops.filter((op) => !op.ignored) : ops;
  const { added, removed } = diffStats(real);
  const { lines, truncated } = toHunks(ops);
  const base = { added, removed, lines, truncated, fired: [...annotated.fired] };
  const prev = maskText(prevText, noise);
  const next = maskText(nextText, noise);
  if (prev === next) return { ...base, changed: false, noiseOnly: true, summary: NOISE_ONLY_SUMMARY };

  switch (rule.mode) {
    case 'number': {
      const beforeNumbers = extractNumbers(prev);
      const afterNumbers = extractNumbers(next);
      if (sameNumbers(beforeNumbers, afterNumbers)) return { ...base, changed: false, summary: textSummary(real, added, removed) };
      return { ...base, changed: true, summary: numberSummary(beforeNumbers, afterNumbers) };
    }
    case 'keyword': {
      const was = hasKeyword(prev, rule.keyword);
      const is = hasKeyword(next, rule.keyword);
      const summary = was === is ? textSummary(real, added, removed) : keywordSummary(rule.keyword, is);
      return { ...base, changed: was !== is, summary };
    }
    case 'below': {
      const target = parseTarget(rule.target ?? '');
      if (!target) return { ...base, changed: false, summary: textSummary(real, added, removed) };
      const beforePrice = findPrice(prev, target.currency);
      const afterPrice = findPrice(next, target.currency);
      // Only crossing the target counts: once below, further moves stay quiet until it goes back up.
      const crossed =
        afterPrice !== null && afterPrice.value < target.value && !(beforePrice !== null && beforePrice.value < target.value);
      if (!crossed) {
        const summary =
          beforePrice && afterPrice && beforePrice.raw !== afterPrice.raw ? priceSummary(beforePrice, afterPrice) : textSummary(real, added, removed);
        return { ...base, changed: false, summary };
      }
      return { ...base, changed: true, summary: belowSummary(rule.target ?? '', beforePrice, afterPrice) };
    }
    case 'lowest': {
      const beforeValue = readValue(prev);
      const afterValue = readValue(next);
      const low = afterValue ? newLow(context.history ?? [], afterValue.value, context.now ?? Date.now()) : null;
      if (!afterValue || !low) {
        const summary =
          beforeValue && afterValue && beforeValue.raw !== afterValue.raw ? valueSummary(beforeValue, afterValue) : textSummary(real, added, removed);
        return { ...base, changed: false, summary };
      }
      return { ...base, changed: true, summary: lowestSummary(afterValue, low) };
    }
    default:
      return { ...base, changed: true, summary: textSummary(real, added, removed) };
  }
}

function valueSummary(before: Price, after: Price): string {
  return `${before.currency || after.currency ? 'Price' : 'Number'} changed: ${before.raw} → ${after.raw}`;
}

const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

/** "Lowest in 30 days: $89.00 (was $99.00)", or "Lowest since Sep 20: …" while the history is shorter. */
export function lowestSummary(value: Price, low: NewLow, days = 30): string {
  const label = low.fullWindow ? `Lowest in ${days} days` : `Lowest since ${shortDate.format(low.since)}`;
  return `${label}: ${value.raw} (was ${low.previousLow.r})`;
}

function priceSummary(before: Price, after: Price): string {
  return `Price changed: ${before.raw} → ${after.raw}`;
}

/** "Price dropped below $100: $129.00 → $89.00". */
export function belowSummary(target: string, before: Price | null, after: Price): string {
  const label = `Price dropped below ${collapseSpaces(target)}`;
  return before ? `${label}: ${before.raw} → ${after.raw}` : `${label}: now ${after.raw}`;
}

/**
 * Where a price watch stands right now, for messages when it's added: null when there's no
 * price to follow, otherwise the price found and whether it's already below the target.
 */
export function priceStatus(text: string, target: string): { price: Price; below: boolean } | null {
  const parsed = parseTarget(target);
  if (!parsed) return null;
  const price = findPrice(text, parsed.currency);
  return price ? { price, below: price.value < parsed.value } : null;
}

export function hasKeyword(text: string, keyword: string): boolean {
  const needle = collapseSpaces(keyword).toLowerCase();
  return needle.length > 0 && collapseSpaces(text).toLowerCase().includes(needle);
}

function quote(text: string, max = 40): string {
  const clean = collapseSpaces(text);
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

export function keywordSummary(keyword: string, present: boolean): string {
  return `${quote(keyword)} ${present ? 'appeared' : 'disappeared'}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "Changed: “Out of stock” → “In stock”" for a one-line swap, otherwise "+3 lines, −1 line". */
export function textSummary(ops: readonly DiffOp[], added: number, removed: number): string {
  if (added === 1 && removed === 1) {
    const oldLine = ops.find((op) => op.type === 'remove' && !op.ignored)!.text;
    const newLine = ops.find((op) => op.type === 'add' && !op.ignored)!.text;
    if (oldLine.length <= 80 && newLine.length <= 80) return `Changed: ${quote(oldLine)} → ${quote(newLine)}`;
  }
  const parts: string[] = [];
  if (added) parts.push(`+${plural(added, 'line')}`);
  if (removed) parts.push(`${MINUS}${plural(removed, 'line')}`);
  return parts.join(', ') || 'Text changed';
}

/** "Price changed: $129 → $99", "New number: 12", "(+2 more)" when several moved. */
export function numberSummary(before: readonly NumberToken[], after: readonly NumberToken[]): string {
  const ops = diffLines(
    before.map((token) => token.raw),
    after.map((token) => token.raw),
  );
  const isPrice = (raw: string) => before.some((t) => t.raw === raw && t.isPrice) || after.some((t) => t.raw === raw && t.isPrice);

  const events: string[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      const label = isPrice(removed[i]!) || isPrice(added[i]!) ? 'Price' : 'Number';
      events.push(`${label} changed: ${removed[i]} → ${added[i]}`);
    }
    for (const raw of removed.slice(pairs)) events.push(`${isPrice(raw) ? 'Price' : 'Number'} removed: ${raw}`);
    for (const raw of added.slice(pairs)) events.push(`New ${isPrice(raw) ? 'price' : 'number'}: ${raw}`);
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.type === 'remove') removed.push(op.text);
    else if (op.type === 'add') added.push(op.text);
    else flush();
  }
  flush();

  const [first, ...rest] = events;
  if (!first) return 'Numbers changed';
  return rest.length ? `${first} (+${rest.length} more)` : first;
}
