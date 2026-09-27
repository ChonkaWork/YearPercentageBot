import type { Analysis, Factor } from './analyze';
import type { LiquidityLevel, VolumeLevel } from './metrics';
import { isSignalLabel, type SignalLabel } from './momentum';
import { isFiniteNumber } from './numbers';
import { normalizeChange, normalizeProbability } from './probability';
import { cleanSeries } from './series';
import { isMarketRef, isValidSlug, refKey } from './slug';
import { isHistoryRange, type HistoryRange, type MarketKind, type MarketRef, type PricePoint } from './types';

/**
 * Models for what the extension stores locally (watchlist and analysis history), with
 * sanitizers: storage is read back through these, so a corrupted or outdated entry is
 * repaired or dropped instead of breaking the popup.
 */

/** The numbers shown in the watchlist, compare view and alerts. */
export interface MarketSummary {
  probability: number | null;
  change24h: number | null;
  change7d: number | null;
  volume24h: number | null;
  liquidity: number | null;
  signal: SignalLabel | null;
  strength: number | null;
  at: number;
}

export interface WatchItem {
  key: string;
  ref: MarketRef;
  title: string;
  /** The outcome the probability refers to ("Yes", or the label in a multi-outcome event). */
  outcome: string;
  addedAt: number;
  /** Latest refresh. */
  last: MarketSummary | null;
  /** The refresh before that, for the arrow and alerts. */
  previous: MarketSummary | null;
  /** Alert messages from the latest refresh. */
  alerts: string[];
}

export interface Snapshot {
  id: string;
  key: string;
  /** What was opened (page or search result). */
  ref: MarketRef;
  /** The analyzed market inside the event (the selected outcome of a multi-outcome event). */
  selectedSlug: string | null;
  savedAt: number;
  kind: MarketKind;
  title: string;
  eventTitle: string | null;
  outcome: string;
  /** Names and prices of the market's own outcomes (Yes/No). */
  outcomes: { name: string; probability: number | null }[];
  endDate: number | null;
  summary: MarketSummary;
  volumeLevel: VolumeLevel;
  volumeRatio: number | null;
  liquidityLevel: LiquidityLevel;
  unusual: { title: string; detail: string }[];
  factors: Factor[];
  explanation: string;
  warnings: string[];
  series: PricePoint[];
  seriesRange: HistoryRange;
}

// --- Sanitizers ---------------------------------------------------------------------------

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 2000;

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function nonNegativeOrNull(value: unknown): number | null {
  return isFiniteNumber(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter((item): item is string => item !== null).slice(0, maxItems);
}

export function sanitizeSummary(value: unknown): MarketSummary | null {
  const raw = record(value);
  const at = timestamp(raw?.at);
  if (!raw || at === null) return null;
  const strength = finiteOrNull(raw.strength);
  return {
    probability: normalizeProbability(raw.probability),
    change24h: normalizeChange(raw.change24h),
    change7d: normalizeChange(raw.change7d),
    volume24h: nonNegativeOrNull(raw.volume24h),
    liquidity: nonNegativeOrNull(raw.liquidity),
    signal: isSignalLabel(raw.signal) ? raw.signal : null,
    strength: strength !== null && strength >= 0 && strength <= 100 ? Math.round(strength) : null,
    at,
  };
}

export function sanitizeWatchItem(value: unknown): WatchItem | null {
  const raw = record(value);
  if (!raw || !isMarketRef(raw.ref)) return null;
  const ref: MarketRef = { eventSlug: raw.ref.eventSlug, marketSlug: raw.ref.marketSlug };
  const title = text(raw.title);
  const addedAt = timestamp(raw.addedAt);
  if (!title || addedAt === null) return null;
  return {
    key: refKey(ref),
    ref,
    title,
    outcome: text(raw.outcome, 120) ?? 'Yes',
    addedAt,
    last: sanitizeSummary(raw.last),
    previous: sanitizeSummary(raw.previous),
    alerts: textList(raw.alerts, 5),
  };
}

export function sanitizeWatchlist(value: unknown, max: number): WatchItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: WatchItem[] = [];
  for (const entry of value) {
    const item = sanitizeWatchItem(entry);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  return items.slice(0, max);
}

const VOLUME_LEVELS: readonly VolumeLevel[] = ['LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'UNKNOWN'];
const LIQUIDITY_LEVELS: readonly LiquidityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'];

export function sanitizeSnapshot(value: unknown): Snapshot | null {
  const raw = record(value);
  if (!raw || !isMarketRef(raw.ref)) return null;
  const ref: MarketRef = { eventSlug: raw.ref.eventSlug, marketSlug: raw.ref.marketSlug };
  const id = text(raw.id, 100);
  const savedAt = timestamp(raw.savedAt);
  const title = text(raw.title);
  const summary = sanitizeSummary(raw.summary);
  if (!id || savedAt === null || !title || !summary) return null;

  const outcomes = Array.isArray(raw.outcomes)
    ? raw.outcomes
        .map((entry) => record(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null && text(entry.name, 120) !== null)
        .map((entry) => ({ name: text(entry.name, 120) as string, probability: normalizeProbability(entry.probability) }))
        .slice(0, 10)
    : [];
  const factors: Factor[] = Array.isArray(raw.factors)
    ? raw.factors
        .map((entry) => record(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({ tone: entry.tone === 'caution' ? ('caution' as const) : ('support' as const), text: text(entry.text) ?? '' }))
        .filter((factor) => factor.text)
        .slice(0, 10)
    : [];
  const unusual = Array.isArray(raw.unusual)
    ? raw.unusual
        .map((entry) => record(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({ title: text(entry.title, 120) ?? '', detail: text(entry.detail) ?? '' }))
        .filter((signal) => signal.title && signal.detail)
        .slice(0, 10)
    : [];
  const series = Array.isArray(raw.series)
    ? cleanSeries(
        raw.series
          .map((entry) => record(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
          .map((entry) => ({ t: Number(entry.t), p: Number(entry.p) })),
      ).slice(-200)
    : [];

  return {
    id,
    key: refKey(ref),
    ref,
    selectedSlug: isValidSlug(raw.selectedSlug) ? raw.selectedSlug : null,
    savedAt,
    kind: raw.kind === 'multi' ? 'multi' : 'binary',
    title,
    eventTitle: text(raw.eventTitle),
    outcome: text(raw.outcome, 120) ?? 'Yes',
    outcomes,
    endDate: timestamp(raw.endDate),
    summary,
    volumeLevel: VOLUME_LEVELS.includes(raw.volumeLevel as VolumeLevel) ? (raw.volumeLevel as VolumeLevel) : 'UNKNOWN',
    volumeRatio: nonNegativeOrNull(raw.volumeRatio),
    liquidityLevel: LIQUIDITY_LEVELS.includes(raw.liquidityLevel as LiquidityLevel) ? (raw.liquidityLevel as LiquidityLevel) : 'UNKNOWN',
    unusual,
    factors,
    explanation: text(raw.explanation, MAX_LONG_TEXT) ?? '',
    warnings: textList(raw.warnings, 5),
    series,
    seriesRange: isHistoryRange(raw.seriesRange) ? raw.seriesRange : '7d',
  };
}

export function sanitizeSnapshots(value: unknown, max: number): Snapshot[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Snapshot[] = [];
  for (const entry of value) {
    const snapshot = sanitizeSnapshot(entry);
    if (!snapshot || seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    result.push(snapshot);
  }
  return result.sort((a, b) => b.savedAt - a.savedAt).slice(0, max);
}

/** The watchlist/compare numbers of an analysis. */
export function summarize(analysis: Analysis, at: number): MarketSummary {
  return {
    probability: analysis.probability,
    change24h: analysis.change24h,
    change7d: analysis.change7d,
    volume24h: analysis.volume.volume24h,
    liquidity: analysis.liquidity.usd,
    signal: analysis.momentum.label,
    strength: analysis.momentum.strength,
    at,
  };
}

// --- List operations (pure) -----------------------------------------------------------------

export type AddResult = { ok: true; items: WatchItem[] } | { ok: false; reason: 'limit' | 'exists'; items: WatchItem[] };

export function addToWatchlist(items: readonly WatchItem[], item: WatchItem, max: number): AddResult {
  if (items.some((existing) => existing.key === item.key)) return { ok: false, reason: 'exists', items: items.slice() };
  if (items.length >= max) return { ok: false, reason: 'limit', items: items.slice() };
  return { ok: true, items: [item, ...items] };
}

export function removeFromWatchlist(items: readonly WatchItem[], key: string): WatchItem[] {
  return items.filter((item) => item.key !== key);
}

/** Records a refresh: the old "last" becomes "previous" (only if the new one is newer). */
export function recordRefresh(item: WatchItem, summary: MarketSummary, alerts: string[]): WatchItem {
  if (item.last && item.last.at >= summary.at) return item;
  return { ...item, previous: item.last, last: summary, alerts };
}

/** Change between the two latest refreshes, for the watchlist arrow. */
export function refreshChange(item: WatchItem): number | null {
  if (!item.last || !item.previous) return null;
  const { probability: now } = item.last;
  const { probability: before } = item.previous;
  return isFiniteNumber(now) && isFiniteNumber(before) ? now - before : null;
}

/** Analyses of the same market within this window replace each other instead of piling up. */
export const SNAPSHOT_DEDUPE_MS = 10 * 60 * 1000;

export function addSnapshot(snapshots: readonly Snapshot[], snapshot: Snapshot, max: number): Snapshot[] {
  if (max <= 0) return [];
  const rest = snapshots.filter(
    (existing) =>
      existing.id !== snapshot.id &&
      !(existing.key === snapshot.key && existing.selectedSlug === snapshot.selectedSlug && Math.abs(snapshot.savedAt - existing.savedAt) < SNAPSHOT_DEDUPE_MS),
  );
  return [snapshot, ...rest].sort((a, b) => b.savedAt - a.savedAt).slice(0, max);
}
