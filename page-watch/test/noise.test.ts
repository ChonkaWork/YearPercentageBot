import { describe, expect, it } from 'vitest';
import { evaluateChange } from '../src/core/compare';
import {
  annotateOps,
  confirmRules,
  emptyNoise,
  GAP,
  LEARN_CHECKS,
  learnFromPair,
  learnNoise,
  lineSegments,
  maskText,
  noiseGroups,
  noisyLineCount,
  removeRules,
  sanitizeNoise,
  type NoiseRule,
} from '../src/core/noise';
import { diffLines } from '../src/core/diff';

/** A product page with the usual noise; `n` is the request number. */
function productPage(n: number, real: { price?: string; stock?: string; trending?: string[]; extraLine?: string } = {}): string {
  const viewers = [12, 15, 9, 21, 17, 30][n % 6];
  const seconds = String((n * 7) % 60).padStart(2, '0');
  const ids = ['7f3a9c1e2b4d', '0be41d77c9a2', '93c1aa0e5f6b', '5d2e8b41c0f7', 'c81f03a9d62e', '2a9b7e5c41d0'];
  const recommendations = [
    ['Brass Floor Lamp · $59.00', 'Oak Side Table · $129.00'],
    ['Linen Shade · $39.00', 'Walnut Tray · $25.00'],
    ['Wool Rug · $149.00', 'Ceramic Vase · $32.00', 'Desk Organizer · $19.00'],
  ][n % 3]!;
  const trending = real.trending ?? ['Linen Shade', 'Oak Side Table', 'Wool Rug', 'Brass Floor Lamp'];
  const rotated = trending.map((_, index) => trending[(index + n) % trending.length]!);
  return [
    'Lumen Store',
    'Lamps · Desks · Sale',
    'Aurora Desk Lamp',
    'Warm, dimmable LED lamp with a brushed aluminium arm.',
    `${real.price ?? '$129.00'} incl. VAT`,
    real.stock ?? 'In stock',
    `${viewers} people are viewing this right now`,
    ...(real.extraLine ? [real.extraLine] : []),
    'Customers also bought',
    ...recommendations,
    'Trending now',
    ...rotated,
    `Page generated at 14:05:${seconds} · Request ID ${ids[n % ids.length]}`,
    '© Lumen Store',
  ].join('\n');
}

const text = { mode: 'text' as const, keyword: '' };
const number = { mode: 'number' as const, keyword: '' };

describe('lineSegments', () => {
  it('finds the changing part of a counter or a timestamp, with the words around it', () => {
    expect(lineSegments('12 people are viewing this right now', '15 people are viewing this right now')).toEqual([
      { left: '', right: ' people are viewing', start: true, end: false },
    ]);
    expect(lineSegments('Page generated at 14:05:32 · Request ID 7f3a9c1e2b4d', 'Page generated at 14:05:39 · Request ID 0be41d77c9a2')).toEqual([
      { left: 'Page generated at ', right: ' · Request ID ', start: true, end: false },
      { left: ' · Request ID ', right: '', start: false, end: true },
    ]);
    expect(lineSegments('Updated 5 minutes ago', 'Updated 6 minutes ago')).toEqual([{ left: 'Updated ', right: ' minutes ago', start: true, end: true }]);
  });

  it('refuses lines with too little in common (they become blocks, never "…" rules that match anything)', () => {
    expect(lineSegments('$129.00', '$99.00')).toBeNull();
    expect(lineSegments('Brass Floor Lamp · $59.00', 'Linen Shade · $39.00')).toBeNull();
    expect(lineSegments('In stock', 'Out of stock')).toBeNull();
    expect(lineSegments('12 · 15', '13 · 16')).toBeNull();
  });
});

describe('learnNoise', () => {
  const rules = learnNoise(productPage(0), productPage(1));

  it('learns counters, timestamps and ids as segments, rotating recommendations as a block, a shuffled list by order', () => {
    const groups = noiseGroups(rules);
    expect(groups.map((group) => [group.kind, group.text, group.anchor, group.lines])).toEqual([
      ['order', 'Linen Shade, Oak Side Table, Wool Rug, …', 'Trending now', 4],
      ['segment', `${GAP} people are viewing this right now`, null, 1],
      ['block', 'Brass Floor Lamp · $59.00', 'Customers also bought', 2],
      ['segment', `Page generated at ${GAP} · Request ID ${GAP}`, null, 1],
    ]);
    // One line each for the two noisy lines, the recommendations block and the list.
    expect(noisyLineCount(rules)).toBe(1 + 2 + 4 + 1);
  });

  it('learns nothing when nothing changed', () => {
    expect(learnNoise(productPage(0), productPage(0))).toEqual([]);
  });

  it("never learns the whole text as one block", () => {
    expect(learnNoise('alpha\nbeta', 'gamma\ndelta')).toEqual([]);
  });

  it('only anchors blocks on lines that appear once', () => {
    // "Ad: Summer sale" → "Ad: New arrivals" has too little in common for a segment, and
    // "Add to cart" appears twice, so there's nothing safe to anchor a block on.
    const before = ['Add to cart', 'Ad: Summer sale', 'Add to cart', 'Footer'].join('\n');
    const after = ['Add to cart', 'Ad: New arrivals', 'Add to cart', 'Footer'].join('\n');
    expect(learnNoise(before, after)).toEqual([]);
    // With a unique line before it, the block is learned, anchored on the shortest unique run.
    const anchored = learnNoise(`Deals\n${before}`, `Deals\n${after}`);
    expect(anchored).toMatchObject([{ kind: 'block', before: ['Deals', 'Add to cart'], after: ['Add to cart', 'Footer'], lines: 1 }]);
  });
});

describe('noise filter: change detection', () => {
  const rules = learnNoise(productPage(0), productPage(1));

  it('masks what the rules explain, whatever the next values are', () => {
    for (let n = 2; n < 8; n++) expect(maskText(productPage(n), rules)).toBe(maskText(productPage(0), rules));
    expect(maskText(productPage(3), rules)).toContain(`${GAP} people are viewing this right now`);
  });

  it('timestamps, counters, ids, recommendations and list order alone are not a change', () => {
    for (let n = 2; n < 8; n++) {
      const result = evaluateChange(productPage(n - 1), productPage(n), text, { noise: rules })!;
      expect(result.changed).toBe(false);
      expect(result.noiseOnly).toBe(true);
      expect(result.added + result.removed).toBe(0);
      expect(new Set(result.fired).size).toBeGreaterThan(0);
    }
  });

  it('a real price change still alerts, in text and number mode, with the noise greyed in the diff', () => {
    const before = productPage(4);
    const after = productPage(5, { price: '$99.00' });
    const textResult = evaluateChange(before, after, text, { noise: rules })!;
    expect(textResult.changed).toBe(true);
    expect(textResult.summary).toBe('Changed: “$129.00 incl. VAT” → “$99.00 incl. VAT”');
    expect([textResult.added, textResult.removed]).toEqual([1, 1]);
    const ignored = textResult.lines.filter((line) => line.ignored);
    expect(ignored.length).toBeGreaterThan(0);
    expect(textResult.lines.filter((line) => (line.type === 'add' || line.type === 'remove') && !line.ignored).map((line) => line.text)).toEqual([
      '$129.00 incl. VAT',
      '$99.00 incl. VAT',
    ]);

    const numberResult = evaluateChange(before, after, number, { noise: rules })!;
    expect(numberResult.changed).toBe(true);
    // The viewer count and the recommendation prices don't get in the way.
    expect(numberResult.summary).toBe('Price changed: $129.00 → $99.00');
  });

  it('without the filter the same noise is a change', () => {
    expect(evaluateChange(productPage(1), productPage(2), text)!.changed).toBe(true);
    expect(evaluateChange(productPage(1), productPage(2), number)!.changed).toBe(true);
  });

  it('a noisy line that goes away, or a new line, is a real change', () => {
    const gone = productPage(2).replace(/^\d+ people are viewing this right now$/m, 'Sold out: back in October');
    const result = evaluateChange(productPage(1), gone, text, { noise: rules })!;
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Changed: “15 people are viewing this right now” → “Sold out: back in October”');
    const extra = evaluateChange(productPage(1), productPage(2, { extraLine: 'Free shipping this week' }), text, { noise: rules })!;
    expect(extra).toMatchObject({ changed: true, summary: '+1 line', added: 1, removed: 0 });
  });

  it('a shuffled list: reordering is ignored, a new or removed item is not', () => {
    const items = ['Linen Shade', 'Oak Side Table', 'Wool Rug', 'Brass Floor Lamp'];
    const added = evaluateChange(productPage(2), productPage(3, { trending: [...items, 'Cork Coasters'] }), text, { noise: rules })!;
    expect(added.changed).toBe(true);
    expect(added.lines.filter((line) => line.type === 'add' && !line.ignored).map((line) => line.text)).toEqual(['Cork Coasters']);
    const removed = evaluateChange(productPage(2), productPage(3, { trending: items.slice(0, 3) }), text, { noise: rules })!;
    expect(removed.changed).toBe(true);
    expect(removed.removed).toBe(1);
  });

  it('keyword and price rules read the masked text', () => {
    // "Sold out" inside a rotating recommendation isn't the product being sold out.
    const before = 'Aurora Desk Lamp\n$129.00\nYou may also like\nOak Side Table · Sold out\nFooter';
    const after = 'Aurora Desk Lamp\n$129.00\nYou may also like\nLinen Shade · $39.00\nFooter';
    const learned = learnNoise(before, after);
    expect(learned.map((rule) => rule.kind)).toEqual(['block']);
    expect(evaluateChange(after, before, { mode: 'keyword', keyword: 'Sold out' }, { noise: learned })!.changed).toBe(false);
    expect(evaluateChange(after, before, { mode: 'keyword', keyword: 'Sold out' })!.changed).toBe(true);
    const cheaper = after.replace('$129.00', '$89.00');
    expect(evaluateChange(after, cheaper, { mode: 'below', keyword: '', target: '$100' }, { noise: learned })!).toMatchObject({
      changed: true,
      summary: 'Price dropped below $100: $129.00 → $89.00',
    });
  });

  it('annotates only lines whose counterpart is there on the other side', () => {
    const a = ['Title', '12 people are viewing this right now', 'End'];
    const b = ['Title', '14 people are viewing this right now', 'End'];
    const learned = learnNoise(a.join('\n'), b.join('\n'));
    const { ops, fired } = annotateOps(diffLines(a, ['Title', 'Gone', 'End']), a, ['Title', 'Gone', 'End'], learned);
    expect(ops.filter((op) => op.ignored)).toEqual([]);
    expect(fired.size).toBe(0);
    const c = ['Title', '19 people are viewing this right now', 'End'];
    const second = annotateOps(diffLines(a, c), a, c, learned);
    expect(second.ops.filter((op) => op.ignored).map((op) => op.type)).toEqual(['remove', 'add']);
    expect([...second.fired]).toEqual([learned[0]!.id]);
  });
});

describe('noise state', () => {
  it('learns from the pair, then keeps only rules confirmed by later checks', () => {
    const before = 'Title\n12 people are viewing\nPrice $129.00\nEnd';
    // The price happened to change in the few seconds between the two fetches.
    const after = 'Title\n15 people are viewing\nPrice $119.00\nEnd';
    let state = learnFromPair(emptyNoise(), before, after);
    expect(state.phase).toBe('confirm');
    expect(state.checksLeft).toBe(LEARN_CHECKS);
    expect(state.rules).toHaveLength(2);
    const viewers = state.rules.find((rule) => rule.sample.includes('people'))!.id;
    for (let check = 0; check < LEARN_CHECKS; check++) state = confirmRules(state, check === 1 ? [] : [viewers]);
    expect(state.phase).toBe('done');
    // The price never moved again: it's watched as usual from now on.
    expect(state.rules.map((rule) => rule.id)).toEqual([viewers]);
    expect(confirmRules(state, [])).toBe(state);
  });

  it('removes a line group ("Watch this line again")', () => {
    const rules = learnNoise(productPage(0), productPage(1));
    const timestamps = rules.filter((rule) => rule.sample.startsWith('Page generated'));
    expect(timestamps).toHaveLength(2);
    const state = removeRules({ phase: 'done', checksLeft: 0, rules }, timestamps[0]!.id);
    expect(state.rules.some((rule) => rule.sample.startsWith('Page generated'))).toBe(false);
    expect(state.rules).toHaveLength(rules.length - 2);
  });

  it('sanitizes what it reads from storage', () => {
    const rules = learnNoise(productPage(0), productPage(1));
    const state = { phase: 'confirm', checksLeft: 2, rules };
    expect(sanitizeNoise(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(sanitizeNoise(undefined)).toEqual({ phase: 'done', checksLeft: 0, rules: [] });
    const junk: unknown[] = [
      null,
      { kind: 'segment', id: 'x', sample: 's', left: '', right: '$', start: true, end: false },
      { kind: 'block', id: 'y', sample: 's', before: null, after: null },
      { kind: 'block', id: 'z', sample: 's', before: 'not an array', after: ['x'] },
      { kind: 'other' },
    ];
    expect(sanitizeNoise({ phase: 'weird', rules: junk })).toEqual({ phase: 'done', checksLeft: 0, rules: [] });
    const good: NoiseRule = { kind: 'block', id: 'b', sample: 's', before: ['A'], after: null, lines: 3, hits: 1 };
    expect(sanitizeNoise({ phase: 'confirm', checksLeft: 0, rules: [good] })).toEqual({ phase: 'done', checksLeft: 0, rules: [good] });
  });
});
