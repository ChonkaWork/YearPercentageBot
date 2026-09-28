import { describe, expect, it } from 'vitest';
import { decimalSeparatorFor, parseNumber } from '../src/core/cellValue';

const value = (text: string, decimal: '.' | ',' = '.') => parseNumber(text, decimal)?.value ?? null;

describe('parseNumber', () => {
  it('reads plain, signed, decimal and grouped numbers', () => {
    expect(value('42')).toBe(42);
    expect(value('  -7 ')).toBe(-7);
    expect(value('+3.25')).toBe(3.25);
    expect(value('0.5')).toBe(0.5);
    expect(value('1,234')).toBe(1234);
    expect(value('2,952,301')).toBe(2952301);
    expect(value('1,234.56')).toBe(1234.56);
    expect(value('10 000')).toBe(10000);
    expect(value('−12')).toBe(-12); // Unicode minus (Wikipedia)
    expect(value('-0')).toBe(0);
  });

  it('reads percentages as fractions', () => {
    expect(parseNumber('12.5%')).toEqual({ value: 0.125, percent: true, decimals: 1, grouped: false });
    expect(parseNumber('14.3%')?.value).toBe(0.143);
    expect(parseNumber('7 %')?.value).toBe(0.07);
  });

  it('follows the page decimal separator', () => {
    expect(value('1,5', ',')).toBe(1.5);
    expect(value('1.234,5', ',')).toBe(1234.5);
    expect(value('1 234,5', ',')).toBe(1234.5);
    expect(value('1,234', ',')).toBe(1.234);
    expect(value('1.5', ',')).toBeNull();
    expect(value('1,5', '.')).toBeNull();
  });

  it('keeps anything ambiguous as text', () => {
    for (const text of ['007', '05', '00.5', '', ' ', '-', '$12', '12 kg', '1.2.3', '2024-01-05', '1,23,456', '1e5', '0x1F', 'NaN', 'Infinity', '12/05', '1,2345', '(5)', '+-5']) {
      expect(parseNumber(text), text).toBeNull();
    }
  });

  it('refuses more than 15 significant digits (IDs, card numbers)', () => {
    expect(value('123456789012345')).toBe(123456789012345);
    expect(value('1234567890123456')).toBeNull();
    expect(value('4111 1111 1111 1111')).toBeNull();
    expect(value('0.1234567890123456')).toBeNull();
  });

  it('reports grouping and decimals for number formats', () => {
    expect(parseNumber('1,234.50')).toMatchObject({ grouped: true, decimals: 2, percent: false });
    expect(parseNumber('1234')).toMatchObject({ grouped: false, decimals: 0 });
  });
});

describe('decimalSeparatorFor', () => {
  it('uses the locale, "." when unknown', () => {
    expect(decimalSeparatorFor('en')).toBe('.');
    expect(decimalSeparatorFor('uk-UA')).toBe(',');
    expect(decimalSeparatorFor('de')).toBe(',');
    expect(decimalSeparatorFor(undefined)).toBe('.');
    expect(decimalSeparatorFor('not a locale!!')).toBe('.');
  });
});
