import { countdownFraction, currentOccurrence, describeCountdown, type Countdown } from './countdown';
import { formatDateLong, formatPercent, monthName } from './format';
import type { LifeView } from './life';
import { describePeriod } from './periods';
import type { WeekStart } from './time';

/**
 * The share card: a 1200×630 image (the size link previews use) that says how far along
 * something is, with the same 20-block bar the Telegram bot posts: ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░.
 * This is the text model; the page draws it on a canvas in the current theme.
 */

export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 630;
export const SHARE_BLOCKS = 20;

export const SHARE_KINDS = ['year', 'month', 'life', 'countdown'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/**
 * Full blocks for a share, rounded down like the percentages: the last block fills only when the
 * period is over, so 99.99% still shows one empty block.
 */
export function filledBlocks(fraction: number, blocks = SHARE_BLOCKS): number {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.floor(clamped * blocks + 1e-9);
  return clamped < 1 ? Math.min(blocks - 1, filled) : blocks;
}

/** "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░" */
export function blockBar(fraction: number, blocks = SHARE_BLOCKS): string {
  const filled = filledBlocks(fraction, blocks);
  return '▓'.repeat(filled) + '░'.repeat(blocks - filled);
}

export interface ShareCard {
  kind: ShareKind;
  /** Small uppercase label on top: "Year progress". */
  eyebrow: string;
  /** "2026 is 79.00% complete" */
  headline: string;
  /** The part of the headline drawn in the accent color and mono font ("79.00%"); may be empty. */
  emphasis: string;
  /** 0..1 for the bar, or null to leave it out. */
  fraction: number | null;
  /** Full blocks of SHARE_BLOCKS (0 without a bar). */
  blocks: number;
  /** Text version of the bar ("" without one). */
  bar: string;
  /** "Day 289 of 365 · 76 days 14 h left" */
  caption: string;
  /** "Friday, October 16, 2026": when the card was made. */
  dateline: string;
  /** "progress-tab-2026.png" */
  fileName: string;
}

function card(kind: ShareKind, now: Date, fields: Omit<ShareCard, 'kind' | 'blocks' | 'bar' | 'dateline'>): ShareCard {
  const { fraction } = fields;
  return {
    kind,
    ...fields,
    blocks: fraction === null ? 0 : filledBlocks(fraction),
    bar: fraction === null ? '' : blockBar(fraction),
    dateline: `${formatDateLong(now)}, ${now.getFullYear()}`,
  };
}

export interface PeriodShareOptions {
  weekStart: WeekStart;
  decimals: number;
}

/** "2026 is 79.00% complete" */
export function yearCard(now: Date, options: PeriodShareOptions): ShareCard {
  const view = describePeriod('year', now, options);
  return card('year', now, {
    eyebrow: 'Year progress',
    headline: `${view.label} is ${view.percent.text} complete`,
    emphasis: view.percent.text,
    fraction: view.fraction,
    caption: `${view.caption} · ${view.remainingText}`,
    fileName: `progress-tab-${view.label}.png`,
  });
}

/** "October 2026 is 49.6% complete" */
export function monthCard(now: Date, options: PeriodShareOptions): ShareCard {
  const view = describePeriod('month', now, options);
  const label = `${monthName(now.getMonth())} ${now.getFullYear()}`;
  return card('month', now, {
    eyebrow: 'Month progress',
    headline: `${label} is ${view.percent.text} complete`,
    emphasis: view.percent.text,
    fraction: view.fraction,
    caption: `${view.caption} · ${view.remainingText}`,
    fileName: `progress-tab-${slug(label)}.png`,
  });
}

/** "45.12% of 80 years lived" (Pro). The birth date itself is never on the card. */
export function lifeCard(view: LifeView, now: Date): ShareCard {
  return card('life', now, {
    eyebrow: 'Life in weeks',
    headline: `${view.percent.text} of ${view.years} years lived`,
    emphasis: view.percent.text,
    fraction: view.fraction,
    caption: view.summary.replace(/ \([^)]*\)\.$/, '.'),
    fileName: 'progress-tab-life-in-weeks.png',
  });
}

/**
 * "Flight to Lisbon in 6 days 22 h". The bar is the wait so far (from when the countdown was added,
 * or from its previous date if it repeats), whether or not the list shows it; left out when there
 * is nothing to measure.
 */
export function countdownCard(countdown: Countdown, now: Date, options: { hour12: boolean; decimals: number }): ShareCard | null {
  const view = describeCountdown(countdown, now, options);
  const occurrence = currentOccurrence(countdown, now);
  if (!view || !occurrence) return null;
  const fraction = view.state === 'upcoming' ? countdownFraction(countdown, occurrence, now) : null;
  let headline: string;
  let emphasis: string;
  if (view.state === 'upcoming') {
    headline = `${countdown.name} in ${view.statusText}`;
    emphasis = view.statusText;
  } else if (view.state === 'today') {
    headline = `${countdown.name} is today`;
    emphasis = 'today';
  } else {
    headline = `${countdown.name}: ${view.statusText}`;
    emphasis = '';
  }
  const waited = fraction === null ? '' : ` · ${formatPercent(fraction, options.decimals).text} of the wait is over`;
  return card('countdown', now, {
    eyebrow: 'Countdown',
    headline,
    emphasis,
    fraction,
    caption: `${view.targetText}${view.repeatText ? ` · ${view.repeatText}` : ''}${waited}`,
    fileName: `progress-tab-${slug(countdown.name) || 'countdown'}.png`,
  });
}

/** ASCII file-name part: "Mom’s birthday 🎂" -> "mom-s-birthday". */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** Everything on the card as one sentence (the preview's accessible name). */
export function shareCardText(card: ShareCard): string {
  return [card.headline, card.bar, card.caption].filter(Boolean).join(' · ');
}
