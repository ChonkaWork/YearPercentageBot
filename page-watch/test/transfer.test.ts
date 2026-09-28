import { afterEach, describe, expect, it } from 'vitest';
import { describePicked } from '../src/core/describe';
import { EARLY_ACCESS, setEarlyAccessForTesting } from '../src/core/plan';
import {
  exportFileName,
  exportWatches,
  importSummary,
  parseImportFile,
  planImport,
  validateImported,
  type ExportedWatch,
} from '../src/core/transfer';
import type { Watch } from '../src/core/types';
import { createWatch } from '../src/core/watch';
import { tokenize, wordDiff } from '../src/core/words';

afterEach(() => setEarlyAccessForTesting(EARLY_ACCESS));

const existing: Watch = {
  ...createWatch(
    { url: 'https://shop.example.com/lamp', name: 'Lamp price', selector: '[data-testid="price"]', intervalMinutes: 15, mode: 'number', keyword: '' },
    'w1',
    0,
  ),
  sound: false,
};

describe('words', () => {
  it('keeps numbers, times and ids whole', () => {
    expect(tokenize('$1,299.00 at 14:05:32 · id 7f3a-9c1e')).toEqual(['$', '1,299.00', ' ', 'at', ' ', '14:05:32', ' ', '·', ' ', 'id', ' ', '7f3a-9c1e']);
  });

  it('marks the words that changed on each side', () => {
    // A shared currency sign alone doesn't make two prices "partly the same".
    expect(wordDiff('$129.00', '$99.00')).toEqual({ before: [{ text: '$129.00', changed: true }], after: [{ text: '$99.00', changed: true }] });
    expect(wordDiff('Now $129.00', 'Now $99.00')).toEqual({
      before: [
        { text: 'Now $', changed: false },
        { text: '129.00', changed: true },
      ],
      after: [
        { text: 'Now $', changed: false },
        { text: '99.00', changed: true },
      ],
    });
    expect(wordDiff('Out of stock', 'In stock')).toEqual({
      before: [
        { text: 'Out of', changed: true },
        { text: ' stock', changed: false },
      ],
      after: [
        { text: 'In', changed: true },
        { text: ' stock', changed: false },
      ],
    });
    // Nothing but spaces in common: the whole phrase changed.
    expect(wordDiff('Sold out', 'Back soon')).toEqual({ before: [{ text: 'Sold out', changed: true }], after: [{ text: 'Back soon', changed: true }] });
  });
});

describe('describePicked', () => {
  it('says what was picked in plain words', () => {
    expect(describePicked('$129.00')).toEqual({ label: 'Price', value: '$129.00', detail: null });
    expect(describePicked('$129.00 incl. VAT')).toEqual({ label: 'Price', value: '$129.00', detail: '$129.00 incl. VAT' });
    expect(describePicked('1 299,50 ₴')).toEqual({ label: 'Price', value: '1 299,50 ₴', detail: null });
    expect(describePicked('12 left')).toEqual({ label: 'Number', value: '12', detail: '12 left' });
    expect(describePicked('In stock')).toEqual({ label: 'Text', value: 'In stock', detail: null });
    expect(describePicked('Ships in 3 to 5 business days from our warehouse')).toMatchObject({ label: 'Text' });
    expect(describePicked('Release notes\nVersion 1.1\nNew: alerts')).toEqual({
      label: 'Section',
      value: '3 lines · 37 characters',
      detail: 'Release notes\nVersion 1.1\nNew: alerts',
    });
  });
});

describe('export', () => {
  it('writes the watch settings, not their data', () => {
    const file = exportWatches([existing], Date.UTC(2026, 8, 28));
    expect(file).toEqual({
      format: 'page-watch',
      version: 1,
      exportedAt: '2026-09-28T00:00:00.000Z',
      watches: [
        {
          url: 'https://shop.example.com/lamp',
          name: 'Lamp price',
          selector: '[data-testid="price"]',
          intervalMinutes: 15,
          mode: 'number',
          keyword: '',
          target: '',
          paused: false,
          sound: false,
        },
      ],
    });
    expect(exportFileName(new Date(2026, 8, 3))).toBe('page-watch-2026-09-03.json');
  });

  it('round-trips through import', () => {
    const text = JSON.stringify(exportWatches([existing], 0));
    const parsed = parseImportFile(text);
    expect(parsed).toEqual({ ok: true, watches: exportWatches([existing], 0).watches, invalid: [] });
  });
});

describe('import', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({ url: 'https://docs.example.org/notes', name: 'Notes', ...overrides });

  it('refuses files that are not an export', () => {
    expect(parseImportFile('{not json')).toMatchObject({ ok: false, message: expect.stringMatching(/isn't valid JSON/) });
    expect(parseImportFile('{"hello": 1}')).toMatchObject({ ok: false, message: expect.stringMatching(/isn't a Page Watch export/) });
    expect(parseImportFile('{"format":"page-watch","version":99,"watches":[]}')).toMatchObject({ ok: false, message: expect.stringMatching(/newer version/) });
    expect(parseImportFile('x'.repeat(2_000_001))).toMatchObject({ ok: false, message: expect.stringMatching(/too large/) });
  });

  it('validates each entry and says why one is left out', () => {
    const parsed = parseImportFile(
      JSON.stringify([
        entry(),
        entry({ url: 'javascript:alert(1)' }),
        entry({ url: 'https://a.example.com/', intervalMinutes: 7 }),
        entry({ url: 'https://b.example.com/', mode: 'keyword' }),
        entry({ url: 'https://c.example.com/', mode: 'below', target: 'cheap' }),
        entry({ url: 'https://d.example.com/', selector: 42 }),
        'garbage',
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.watches).toEqual([
      { url: 'https://docs.example.org/notes', name: 'Notes', selector: null, intervalMinutes: 60, mode: 'text', keyword: '', target: '', paused: false, sound: true },
    ]);
    expect(parsed.invalid).toEqual([
      { entry: 2, reason: 'the address is not a web page (http or https)' },
      { entry: 3, reason: 'the interval must be one of 1, 5, 15, 30, 60, 360, 1440 minutes' },
      { entry: 4, reason: 'the keyword rule has no keyword' },
      { entry: 5, reason: 'the price rule has no valid target price' },
      { entry: 6, reason: 'the element selector is not valid' },
      { entry: 7, reason: 'not a watch' },
    ]);
    expect(validateImported({ url: 'https://x.example.com/#top', name: '  ' })).toMatchObject({ ok: true, value: { url: 'https://x.example.com/', name: 'x.example.com' } });
  });

  it('merges: duplicates left out, one entry per page and element', () => {
    const lamp = { ...exportWatches([existing], 0).watches[0]! };
    const plan = planImport([lamp, validate(entry()), validate(entry()), validate(entry({ selector: 'main' }))], [existing], 'pro');
    expect(plan.duplicates).toBe(2);
    expect(plan.add.map((watch) => [watch.url, watch.selector])).toEqual([
      ['https://docs.example.org/notes', null],
      ['https://docs.example.org/notes', 'main'],
    ]);
    expect(plan.origins).toEqual(['https://docs.example.org/*']);
  });

  it('on the free plan: Pro settings become free ones, the watch limit applies', () => {
    setEarlyAccessForTesting(false);
    const entries = ['a', 'b', 'c'].map((host) => validate(entry({ url: `https://${host}.example.com/`, mode: 'number', intervalMinutes: 5 })));
    const plan = planImport(entries, [existing], 'free');
    expect(plan.add).toHaveLength(2);
    expect(plan.add.every((watch) => watch.mode === 'text' && watch.intervalMinutes === 60)).toBe(true);
    expect(plan).toMatchObject({ adapted: 2, overLimit: 1, duplicates: 0 });
    expect(importSummary({ added: 2, duplicates: 1, adapted: 2, overLimit: 1, invalid: 1, noAccess: 0 }, 'free')).toBe(
      'Added 2 watches. 1 was already watched. 2 were set to free options (any text change, every hour or slower): their rules or intervals are part of Pro. 1 was left out: the free plan keeps 3 watches. 1 entry wasn\'t a valid watch.',
    );
    expect(importSummary({ added: 0, duplicates: 0, adapted: 0, overLimit: 0, invalid: 0, noAccess: 2 }, 'pro')).toBe(
      "No watches were added. 2 were left out: Page Watch wasn't allowed to access their sites.",
    );
  });
});

function validate(raw: unknown): ExportedWatch {
  const result = validateImported(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
