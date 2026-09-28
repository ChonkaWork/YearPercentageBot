/**
 * Finds numbers and prices in text, for the "only when a number or price changes" mode.
 * Tokens are compared as written ("$1,299.00"), so no locale guessing is needed.
 */

export interface NumberToken {
  /** As it appears in the text, whitespace collapsed: "$129.00", "1 299 ₴", "15%". */
  raw: string;
  /** Has a currency symbol or code next to it. */
  isPrice: boolean;
  /** Just the number, as written: "1,299.00", "1 299". */
  number: string;
  /** Normalized currency ("USD", "EUR", "UAH", "kr"...), null without one. */
  currency: string | null;
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
    const symbol = groups.prefix ?? (groups.suffix !== '%' ? groups.suffix : undefined);
    const currency = symbol ? normalizeCurrency(symbol) : null;
    tokens.push({ raw, isPrice: currency !== null, number: (groups.n1 ?? groups.n2 ?? '').trim(), currency });
  }
  return tokens;
}

export function sameNumbers(a: readonly NumberToken[], b: readonly NumberToken[]): boolean {
  return a.length === b.length && a.every((token, index) => token.raw === b[index]!.raw);
}

// --- Prices as values (for "the price drops below") -------------------------------------

const CURRENCY_ALIASES: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  C$: 'CAD',
  A$: 'AUD',
  NZ$: 'NZD',
  R$: 'BRL',
  HK$: 'HKD',
  S$: 'SGD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₴': 'UAH',
  ГРН: 'UAH',
  '₽': 'RUB',
  '₩': 'KRW',
  '₪': 'ILS',
  '₺': 'TRY',
  '₫': 'VND',
  '฿': 'THB',
  '₦': 'NGN',
  '₱': 'PHP',
  '₸': 'KZT',
  '₼': 'AZN',
  '₾': 'GEL',
  ZŁ: 'PLN',
  KČ: 'CZK',
  FT: 'HUF',
  LEI: 'RON',
  // SEK, NOK and DKK all write "kr": keep it as its own currency.
  KR: 'kr',
};

/** "$" → "USD", "грн" → "UAH", "eur" → "EUR". Unknown symbols are kept (upper-cased). */
export function normalizeCurrency(symbol: string): string {
  const key = symbol.replace(/\s+/g, '').toUpperCase();
  return CURRENCY_ALIASES[key] ?? key;
}

/**
 * Reads a number written with any common grouping and decimal separators:
 * "1,299.00" and "1.299,00" and "1 299,00" are all 1299; "12,50" is 12.5; "1,299" is 1299
 * (three digits after a single separator are read as thousands).
 */
export function parseAmount(written: string): number | null {
  let text = written.replace(/[\s  ]/g, '');
  if (!/^\d[\d.,]*$/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    text = text.replaceAll(group, '').replace(decimal, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? ',' : '.';
    const parts = text.split(separator);
    const isDecimal = parts.length === 2 && (parts[1]!.length !== 3 || /^0+$/.test(parts[0]!));
    text = isDecimal ? parts.join('.') : parts.join('');
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export interface Price {
  value: number;
  currency: string | null;
  /** As written on the page: "$1,299.00". */
  raw: string;
}

function toPrice(token: NumberToken): Price | null {
  const value = parseAmount(token.number);
  return value === null ? null : { value, currency: token.currency, raw: token.raw };
}

/**
 * Reads a target the user typed ("99.99", "$100", "1 500 грн"). Null when it isn't a positive
 * amount.
 */
export function parseTarget(text: string): Price | null {
  const tokens = extractNumbers(text.trim());
  if (tokens.length !== 1) return null;
  const price = toPrice(tokens[0]!);
  return price && price.value > 0 && !tokens[0]!.raw.endsWith('%') ? price : null;
}

/**
 * The price a "drops below" rule looks at: the first price in the text in the target's
 * currency (any currency when the target has none). Plain numbers only count when the text
 * has no price with a currency at all.
 */
export function findPrice(text: string, currency: string | null): Price | null {
  const tokens = extractNumbers(text).filter((token) => !token.raw.endsWith('%'));
  const priced = tokens.filter((token) => token.currency !== null);
  const candidates = priced.length === 0 ? tokens : currency === null ? priced : priced.filter((token) => token.currency === currency);
  for (const token of candidates) {
    const price = toPrice(token);
    if (price) return price;
  }
  return null;
}
