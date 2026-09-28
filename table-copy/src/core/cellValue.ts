/**
 * Decides which cell texts can safely become numbers in an .xlsx file. "Safely" means
 * the number reads back exactly as the page showed it, so anything ambiguous stays text:
 * leading zeros (codes, ZIPs), more than 15 significant digits (IDs, card numbers that
 * Excel would round), currency, units, dates, versions and anything else with letters.
 */

export type DecimalSeparator = '.' | ',';

export interface NumberValue {
  value: number;
  /** Written as a percentage ("12.5%"): stored as 0.125 with a percent format. */
  percent: boolean;
  /** Decimal places shown on the page, to pick a matching number format. */
  decimals: number;
  /** The page used thousands separators ("1,234"). */
  grouped: boolean;
}

/** The decimal separator of a locale (page language), "." when unknown. */
export function decimalSeparatorFor(locale: string | undefined): DecimalSeparator {
  if (!locale) return '.';
  try {
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value;
    return decimal === ',' ? ',' : '.';
  } catch {
    return '.';
  }
}

const SPACES = '[ \\u00a0\\u202f\\u2009]';
const MINUS = /^[-\u2212\u2012\u2013]/;

function numberPattern(decimal: DecimalSeparator): RegExp {
  const group = decimal === '.' ? `(?:,|${SPACES})` : `(?:\\.|${SPACES})`;
  const point = decimal === '.' ? '\\.' : ',';
  // Integer part: plain digits, or 1-3 digits followed by groups of exactly three.
  return new RegExp(`^(\\d+|\\d{1,3}(?:${group}\\d{3})+)(?:${point}(\\d+))?(%?)$`);
}

const PATTERNS: Record<DecimalSeparator, RegExp> = { '.': numberPattern('.'), ',': numberPattern(',') };

export function parseNumber(raw: string, decimal: DecimalSeparator = '.'): NumberValue | null {
  let text = raw.trim();
  if (!text || text.length > 40) return null;
  let sign = 1;
  if (MINUS.test(text)) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  text = text.replace(/^\s+/, '').replace(new RegExp(`${SPACES}+%$`), '%');
  const match = PATTERNS[decimal].exec(text);
  if (!match) return null;
  const [, integerPart = '', fraction = '', percent] = match;
  const digits = integerPart.replace(/\D/g, '');
  // "007" and "05" are codes, not numbers. "0.5" is fine.
  if (digits.length > 1 && digits.startsWith('0')) return null;
  const significant = `${digits}${fraction}`.replace(/^0+/, '');
  if (significant.length > 15) return null;
  const value = sign * Number(`${digits}.${fraction || '0'}`);
  if (!Number.isFinite(value)) return null;
  const grouped = digits.length !== integerPart.length;
  if (percent) return { value: Number((value / 100).toPrecision(15)), percent: true, decimals: fraction.length, grouped };
  return { value: Object.is(value, -0) ? 0 : value, percent: false, decimals: fraction.length, grouped };
}
