import { describe, expect, it } from 'vitest';
import { belowSummary, evaluateChange, priceStatus } from '../src/core/compare';
import { extractNumbers, findPrice, normalizeCurrency, parseAmount, parseTarget } from '../src/core/numbers';
import type { Snapshot, Watch } from '../src/core/types';
import { applyCheck, applyPatch, createWatch, sanitizeWatch, validateDraft, validatePatch } from '../src/core/watch';

describe('parseAmount', () => {
  it('reads grouping and decimal separators in any common style', () => {
    expect(parseAmount('1,299.00')).toBe(1299);
    expect(parseAmount('1.299,00')).toBe(1299);
    expect(parseAmount('1 299,50')).toBe(1299.5);
    expect(parseAmount('1 299')).toBe(1299);
    expect(parseAmount('1 299,99')).toBe(1299.99);
    expect(parseAmount('12,50')).toBe(12.5);
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('99')).toBe(99);
    expect(parseAmount('1,299')).toBe(1299);
    expect(parseAmount('1.299')).toBe(1299);
    expect(parseAmount('0.500')).toBe(0.5);
    expect(parseAmount('1,234,567.89')).toBe(1234567.89);
    expect(parseAmount('1.234.567')).toBe(1234567);
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('currencies', () => {
  it('normalizes symbols and codes', () => {
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('C$')).toBe('CAD');
    expect(normalizeCurrency('€')).toBe('EUR');
    expect(normalizeCurrency('грн')).toBe('UAH');
    expect(normalizeCurrency('₴')).toBe('UAH');
    expect(normalizeCurrency('zł')).toBe('PLN');
    expect(normalizeCurrency('kr')).toBe('kr');
  });

  it('tags tokens with their number and currency', () => {
    expect(extractNumbers('Now $1,299.00, 12,50 € or 1 299 грн, 15% off, 3 left')).toEqual([
      { raw: '$1,299.00', isPrice: true, number: '1,299.00', currency: 'USD' },
      { raw: '12,50 €', isPrice: true, number: '12,50', currency: 'EUR' },
      { raw: '1 299 грн', isPrice: true, number: '1 299', currency: 'UAH' },
      { raw: '15%', isPrice: false, number: '15', currency: null },
      { raw: '3', isPrice: false, number: '3', currency: null },
    ]);
  });
});

describe('parseTarget', () => {
  it('accepts a positive amount with or without a currency', () => {
    expect(parseTarget('100')).toEqual({ value: 100, currency: null, raw: '100' });
    expect(parseTarget(' 99.99 ')).toMatchObject({ value: 99.99, currency: null });
    expect(parseTarget('$100')).toMatchObject({ value: 100, currency: 'USD' });
    expect(parseTarget('1 500 грн')).toMatchObject({ value: 1500, currency: 'UAH' });
    expect(parseTarget('€1.299,00')).toMatchObject({ value: 1299, currency: 'EUR' });
  });

  it('refuses anything that is not one positive amount', () => {
    for (const bad of ['', 'cheap', '0', '10%', '10 or 20', '$']) expect(parseTarget(bad), bad).toBeNull();
  });
});

describe('findPrice', () => {
  it('takes the first price in the target currency', () => {
    expect(findPrice('Was €150, now $129.00 or €119', 'EUR')?.raw).toBe('€150');
    expect(findPrice('Was €150, now $129.00 or €119', 'USD')?.value).toBe(129);
    expect(findPrice('Was €150, now $129.00', null)?.raw).toBe('€150');
    expect(findPrice('Only $5', 'EUR')).toBeNull();
  });

  it('prefers prices over plain numbers, and uses numbers when there is no price at all', () => {
    expect(findPrice('3 left at $19.99', null)?.value).toBe(19.99);
    expect(findPrice('Price: 1 299,00', null)?.value).toBe(1299);
    expect(findPrice('Price: 1 299,00', 'EUR')?.value).toBe(1299);
    expect(findPrice('Save 20% today', null)).toBeNull();
    expect(findPrice('No price here', null)).toBeNull();
  });
});

describe('evaluateChange: below mode', () => {
  const rule = { mode: 'below' as const, keyword: '', target: '$100' };

  it('notifies when the price crosses below the target', () => {
    const result = evaluateChange('$129.00', '$89.00', rule)!;
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Price dropped below $100: $129.00 → $89.00');
  });

  it('stays quiet above the target and once already below', () => {
    expect(evaluateChange('$129.00', '$119.00', rule)).toMatchObject({ changed: false, summary: 'Price changed: $129.00 → $119.00' });
    expect(evaluateChange('$89.00', '$79.00', rule)!.changed).toBe(false);
    expect(evaluateChange('$89.00', '$109.00', rule)!.changed).toBe(false);
    expect(evaluateChange('$100.00', '$100.00 incl. VAT', rule)!.changed).toBe(false);
  });

  it('notifies again after going back above', () => {
    expect(evaluateChange('$109.00', '$99.99', rule)!.changed).toBe(true);
  });

  it('handles a price that appears, and one that disappears', () => {
    expect(evaluateChange('See price in cart', 'Now $89', rule)).toMatchObject({ changed: true, summary: 'Price dropped below $100: now $89' });
    expect(evaluateChange('$129', 'See price in cart', rule)!.changed).toBe(false);
  });

  it('is currency-aware', () => {
    const euros = { ...rule, target: '100 €' };
    expect(evaluateChange('$129 · 120 €', '$89 · 120 €', euros)!.changed).toBe(false);
    expect(evaluateChange('$129 · 120 €', '$129 · 1.099,00 €', euros)!.changed).toBe(false);
    expect(evaluateChange('$129 · 120 €', '$129 · 99,90 €', euros)!.changed).toBe(true);
    // No currency in the target: any currency counts.
    expect(evaluateChange('1 299 грн', '999 грн', { ...rule, target: '1000' })!.changed).toBe(true);
  });

  it('never fires without a valid target', () => {
    expect(evaluateChange('$129', '$1', { ...rule, target: 'cheap' })!.changed).toBe(false);
  });

  it('summarizes and reports status', () => {
    expect(belowSummary('$100', null, { value: 89, currency: 'USD', raw: '$89' })).toBe('Price dropped below $100: now $89');
    expect(priceStatus('Now $89.00', '$100')).toMatchObject({ below: true, price: { raw: '$89.00' } });
    expect(priceStatus('Now $129.00', '$100')).toMatchObject({ below: false });
    expect(priceStatus('Now €89', '$100')).toBeNull();
    expect(priceStatus('Now $89', 'x')).toBeNull();
  });
});

describe('price watches', () => {
  const NOW = 1_700_000_000_000;
  const priceWatch = (): Watch => ({
    ...createWatch({ url: 'https://shop.example.com/p', name: 'Lamp', selector: '#price', intervalMinutes: 60, mode: 'below', keyword: '', target: '$100' }, 'w', NOW),
    status: 'unchanged',
  });
  const snapshot = (text: string): Snapshot => ({ text, at: NOW - 1, truncated: false });

  it('records a change only when the price drops below the target', () => {
    const context = { now: NOW, random: () => 0.5, changeId: 'c' };
    const above = applyCheck(priceWatch(), snapshot('$129'), [], { ok: true, text: '$119', truncated: false }, context);
    expect(above.change).toBeNull();
    const below = applyCheck(priceWatch(), snapshot('$119'), [], { ok: true, text: '$95', truncated: false }, context);
    expect(below.change?.summary).toBe('Price dropped below $100: $119 → $95');
    expect(below.watch.unseen).toBe(1);
  });

  it('validates the target in drafts and patches', () => {
    const draft = { url: 'https://example.com/', name: 'x', selectors: [], intervalMinutes: 60, mode: 'below', keyword: '', target: ' $100 ', liveText: null };
    expect(validateDraft(draft)).toMatchObject({ ok: true, value: { mode: 'below', target: '$100' } });
    expect(validateDraft({ ...draft, target: 'cheap' })).toMatchObject({ ok: false, message: expect.stringContaining('price') });
    expect(validatePatch({ mode: 'below', target: ' 1 500  грн ' })).toEqual({ ok: true, value: { mode: 'below', target: '1 500 грн' } });
  });

  it('keeps the target only in below mode', () => {
    const watch = priceWatch();
    expect(watch.target).toBe('$100');
    expect(applyPatch(watch, { mode: 'text' }, NOW, () => 0.5)).toMatchObject({ mode: 'text', target: '' });
    expect(applyPatch(watch, { target: '$80' }, NOW, () => 0.5)).toMatchObject({ mode: 'below', target: '$80' });
    expect(applyPatch(watch, { target: 'nope' }, NOW, () => 0.5)).toMatchObject({ mode: 'text', target: '' });
    expect(createWatch({ url: 'https://a.example/', name: 'a', selector: null, intervalMinutes: 60, mode: 'text', keyword: '', target: '$5' }, 'a', NOW).target).toBe('');
  });

  it('sanitizes stored price watches', () => {
    const stored = { ...priceWatch() } as Record<string, unknown>;
    expect(sanitizeWatch(stored)).toMatchObject({ mode: 'below', target: '$100' });
    expect(sanitizeWatch({ ...stored, target: 'junk' })).toMatchObject({ mode: 'text' });
    expect(sanitizeWatch({ ...stored, target: 42 })).toMatchObject({ mode: 'text', target: '' });
    const { target: _target, ...legacy } = stored;
    expect(sanitizeWatch({ ...legacy, mode: 'number' })).toMatchObject({ mode: 'number', target: '' });
  });
});
