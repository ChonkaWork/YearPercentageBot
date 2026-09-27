import { isFiniteNumber } from '../core/numbers';
import { cleanSeries } from '../core/series';
import type { HistoryRange, PricePoint } from '../core/types';
import { DataError } from './errors';

/**
 * Polymarket CLOB API (https://clob.polymarket.com) price history, from the public docs:
 *
 *   GET /prices-history?market=<clob token id>&interval=<1d|1w|1m|max>&fidelity=<minutes>
 *   -> { "history": [ { "t": <unix seconds>, "p": <price 0..1> }, … ] }
 *
 * Assumptions (not verified against the live API): `interval=1m` means one month, `t` is in
 * seconds (values that already look like milliseconds are accepted), and `fidelity` is the
 * sampling resolution in minutes.
 */

export const HISTORY_QUERY: Record<HistoryRange, { interval: string; fidelity: number }> = {
  '24h': { interval: '1d', fidelity: 10 },
  '7d': { interval: '1w', fidelity: 60 },
  '30d': { interval: '1m', fidelity: 360 },
};

export function historyUrl(clobBase: string, tokenId: string, range: HistoryRange): string {
  const { interval, fidelity } = HISTORY_QUERY[range];
  const params = new URLSearchParams({ market: tokenId, interval, fidelity: String(fidelity) });
  return `${clobBase}/prices-history?${params}`;
}

/** Throws INVALID_RESPONSE for a malformed document and MISSING_HISTORY for fewer than 2 usable points. */
export function parsePriceHistory(value: unknown): PricePoint[] {
  const history = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).history : undefined;
  if (!Array.isArray(history)) throw new DataError('INVALID_RESPONSE', 'Price history is malformed');

  const points: PricePoint[] = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const { t, p } = entry as Record<string, unknown>;
    const time = typeof t === 'string' ? Number(t) : t;
    const price = typeof p === 'string' ? Number(p) : p;
    if (!isFiniteNumber(time) || !isFiniteNumber(price) || time <= 0 || price < 0 || price > 1) continue;
    points.push({ t: time < 1e11 ? time * 1000 : time, p: price });
  }
  if (history.length > 0 && points.length === 0) throw new DataError('INVALID_RESPONSE', 'Price history has no valid points');
  const series = cleanSeries(points);
  if (series.length < 2) throw new DataError('MISSING_HISTORY', 'No price history for this market');
  return series;
}
