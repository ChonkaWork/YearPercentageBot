/**
 * Finds numbers and prices in text, for the "only when a number or price changes" mode.
 * Tokens are compared as written ("$1,299.00"), so no locale guessing is needed.
 */

export interface NumberToken {
  /** As it appears in the text, whitespace collapsed: "$129.00", "1 299 ₴", "15%". */
  raw: string;
  /** Has a currency symbol or code next to it. */
  isPrice: boolean;
}

const SYMBOLS = '[$€£¥₹₴₽₩₪₺₫฿₦₱₸₼₾]';
const CODES =
  '(?:USD|EUR|GBP|JPY|CNY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|UAH|RUB|INR|BRL|MXN|ZAR|TRY|ILS|KRW|SGD|HKD|zł|Kč|kr|Ft|lei|грн)';
const PREFIX = `(?:(?:US|C|A|NZ|R|HK|S)?${SYMBOLS}|${CODES})`;
// 1,299.00 · 1.299,00 · 1 299,00 · 1299 · 12.5 · .99 is not matched on purpose (too noisy).
const NUMBER = '\\d{1,3}(?:[,.\\u00a0\\u202f ]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?';
const TOKEN = new RegExp(
  `(?<prefix>${PREFIX})\\s?(?<n1>${NUMBER})|(?<n2>${NUMBER})(?:\\s?(?<suffix>${SYMBOLS}|${CODES}(?![A-Za-z])|%))?`,
  'giu',
);

export function extractNumbers(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    // Skip digits glued to a preceding letter: model names, ids, hashes ("iPhone15", "SKU123").
    const before = start > 0 ? text[start - 1]! : '';
    const groups = match.groups ?? {};
    if (!groups.prefix && /[\p{L}\d_]/u.test(before)) continue;
    const raw = match[0].replace(/\s+/g, ' ').trim();
    const isPrice = Boolean(groups.prefix) || (Boolean(groups.suffix) && groups.suffix !== '%');
    tokens.push({ raw, isPrice });
  }
  return tokens;
}

export function sameNumbers(a: readonly NumberToken[], b: readonly NumberToken[]): boolean {
  return a.length === b.length && a.every((token, index) => token.raw === b[index]!.raw);
}
