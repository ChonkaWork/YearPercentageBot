import { changeDirection, formatPp, formatProbability, formatUsd } from './format';
import { SIGNAL_TEXT, signalDirection } from './momentum';
import type { MarketSummary } from './saved';

/**
 * Side-by-side comparison. Columns keep the order the user picked them in and no cell is
 * highlighted as "best": the view compares data, it doesn't rank markets or suggest bets.
 */

export interface CompareColumn {
  key: string;
  title: string;
  outcome: string;
  summary: MarketSummary | null;
  error?: string;
}

export interface CompareCell {
  text: string;
  /** Second line (e.g. the signal strength). */
  sub?: string;
  tone: 'up' | 'down' | 'flat' | 'muted';
  /** Words rather than a number. */
  label?: boolean;
}

export interface CompareRow {
  label: string;
  cells: CompareCell[];
}

export const MAX_COMPARE = 3;

function sentenceCase(text: string): string {
  return text.charAt(0) + text.slice(1).toLowerCase();
}

export function buildComparison(columns: readonly CompareColumn[]): CompareRow[] {
  const cell = (column: CompareColumn, render: (summary: MarketSummary) => CompareCell): CompareCell =>
    column.summary ? render(column.summary) : { text: '—', tone: 'muted' };
  return [
    { label: 'Probability', cells: columns.map((column) => cell(column, (s) => ({ text: formatProbability(s.probability), tone: 'flat' }))) },
    { label: '24h change', cells: columns.map((column) => cell(column, (s) => ({ text: formatPp(s.change24h), tone: changeDirection(s.change24h) }))) },
    { label: '7d change', cells: columns.map((column) => cell(column, (s) => ({ text: formatPp(s.change7d), tone: changeDirection(s.change7d) }))) },
    { label: 'Volume 24h', cells: columns.map((column) => cell(column, (s) => ({ text: formatUsd(s.volume24h), tone: 'flat' }))) },
    { label: 'Liquidity', cells: columns.map((column) => cell(column, (s) => ({ text: formatUsd(s.liquidity), tone: 'flat' }))) },
    {
      label: 'Momentum',
      cells: columns.map((column) =>
        cell(column, (s) =>
          s.signal
            ? {
                text: sentenceCase(SIGNAL_TEXT[s.signal].replace(' MOMENTUM', '')),
                ...(s.strength !== null ? { sub: `${s.strength}/100` } : {}),
                tone: signalDirection(s.signal),
                label: true,
              }
            : { text: 'Not enough data', tone: 'muted', label: true },
        ),
      ),
    },
  ];
}
