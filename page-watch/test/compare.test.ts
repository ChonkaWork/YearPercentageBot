import { describe, expect, it } from 'vitest';
import { evaluateChange, hasKeyword, numberSummary } from '../src/core/compare';
import { extractNumbers } from '../src/core/numbers';

describe('extractNumbers', () => {
  const raw = (text: string) => extractNumbers(text).map((token) => token.raw);

  it('finds prices in common formats', () => {
    expect(raw('Now $1,299.00 (was $1,499.00)')).toEqual(['$1,299.00', '$1,499.00']);
    expect(raw('Preis: 12,50 € inkl. MwSt.')).toEqual(['12,50 €']);
    expect(raw('Ціна 1 299 ₴')).toEqual(['1 299 ₴']);
    expect(raw('Only USD 99 today, or 89 EUR')).toEqual(['USD 99', '89 EUR']);
    expect(raw('Save 15% now')).toEqual(['15%']);
  });

  it('marks prices', () => {
    expect(extractNumbers('$5 and 3 items and 10%').map((token) => token.isPrice)).toEqual([true, false, false]);
  });

  it('skips digits glued to words (model names, ids)', () => {
    expect(raw('iPhone15 SKU123 v2 but 3 left')).toEqual(['3']);
  });
});

describe('evaluateChange: text mode', () => {
  const rule = { mode: 'text' as const, keyword: '' };

  it('returns null for identical text', () => {
    expect(evaluateChange('a\nb', 'a\nb', rule)).toBeNull();
  });

  it('describes a one-line swap with both values', () => {
    const result = evaluateChange('Status\nOut of stock', 'Status\nIn stock', rule)!;
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Changed: “Out of stock” → “In stock”');
    expect(result.lines.map((line) => line.type)).toEqual(['context', 'remove', 'add']);
  });

  it('counts lines otherwise', () => {
    expect(evaluateChange('a\nb', 'a\nb\nc\nd\ne', rule)!.summary).toBe('+3 lines');
    expect(evaluateChange('a\nb\nc', 'a\nx\ny\nz', rule)!.summary).toBe('+3 lines, −2 lines');
    expect(evaluateChange('a\nb\nc', 'a', rule)!.summary).toBe('−2 lines');
  });
});

describe('evaluateChange: number mode', () => {
  const rule = { mode: 'number' as const, keyword: '' };

  it('reports a price change', () => {
    const result = evaluateChange('Widget\n$129.00\nFree shipping', 'Widget\n$99.00\nFree shipping', rule)!;
    expect(result.changed).toBe(true);
    expect(result.summary).toBe('Price changed: $129.00 → $99.00');
  });

  it('ignores text changes that leave the numbers alone', () => {
    const result = evaluateChange('Widget $129\nIn stock', 'Widget $129\nOnly a few left', rule)!;
    expect(result.changed).toBe(false);
  });

  it('reports plain numbers and extra changes', () => {
    expect(evaluateChange('3 left', '2 left', rule)!.summary).toBe('Number changed: 3 → 2');
    expect(evaluateChange('$10 $20 $30', '$11 $20 $31', rule)!.summary).toBe('Price changed: $10 → $11 (+1 more)');
  });

  it('reports numbers that appear or disappear', () => {
    expect(numberSummary(extractNumbers('Price'), extractNumbers('Price $5'))).toBe('New price: $5');
    expect(numberSummary(extractNumbers('4 seats'), extractNumbers('seats'))).toBe('Number removed: 4');
  });
});

describe('evaluateChange: keyword mode', () => {
  const rule = { mode: 'keyword' as const, keyword: 'sold out' };

  it('fires when the keyword appears or disappears (case and spacing insensitive)', () => {
    const appeared = evaluateChange('Buy now', 'SOLD   OUT', rule)!;
    expect(appeared.changed).toBe(true);
    expect(appeared.summary).toBe('“sold out” appeared');
    const gone = evaluateChange('Sold out', 'Buy now', rule)!;
    expect(gone.changed).toBe(true);
    expect(gone.summary).toBe('“sold out” disappeared');
  });

  it('ignores other changes', () => {
    expect(evaluateChange('Sold out\n1', 'Sold out\n2', rule)!.changed).toBe(false);
    expect(evaluateChange('Buy\n1', 'Buy\n2', rule)!.changed).toBe(false);
  });

  it('matches across line breaks and never matches an empty keyword', () => {
    expect(hasKeyword('Sold\nout', 'sold out')).toBe(true);
    expect(hasKeyword('anything', '  ')).toBe(false);
  });
});
