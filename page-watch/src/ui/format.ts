import { INTERVALS, type ChangeMode, type IntervalMinutes } from '../core/types';
import { h } from './dom';

/** Small "PRO" marker next to Pro features. */
export function proBadge(): HTMLElement {
  return h('span', { class: 'badge pro-badge', text: 'PRO', attrs: { title: 'Part of Page Watch Pro' } });
}

export function intervalLabel(minutes: IntervalMinutes): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} h`;
  return `${minutes / 1440} day`;
}

/** "every 15 minutes", "every hour", "every 6 hours", "every day" for sentences. */
export function intervalPhrase(minutes: IntervalMinutes): string {
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes === 60) return 'every hour';
  if (minutes < 1440) return `every ${minutes / 60} hours`;
  return 'every day';
}

/** Options for the "Check every" select. */
export const INTERVAL_OPTIONS = INTERVALS.map((minutes) => ({
  value: String(minutes),
  label: minutes === 1440 ? '24 hours' : minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`,
}));

export const MODE_OPTIONS: { value: ChangeMode; label: string; help: string }[] = [
  { value: 'text', label: 'Any text change', help: 'Every change in the text.' },
  { value: 'number', label: 'A number or price changes', help: 'Ignores wording changes around them.' },
  { value: 'keyword', label: 'A keyword appears or disappears', help: 'For example “In stock” or “Sold out”.' },
  { value: 'below', label: 'The price drops below', help: 'Uses the first price in the watched part. Add a currency (e.g. $100) to only follow prices in it.' },
];

/** "Notify when" as a sentence ending: "“Sold out” appears or disappears", "the price drops below $100". */
export function ruleDescription(mode: ChangeMode, keyword: string, target: string): string {
  if (mode === 'number') return 'a number or price changes';
  if (mode === 'keyword') return `“${keyword}” appears or disappears`;
  if (mode === 'below') return `the price drops below ${target}`;
  return 'its text changes';
}

export function modeLabel(mode: ChangeMode, keyword: string): string {
  if (mode === 'number') return 'numbers';
  if (mode === 'keyword') return `“${keyword}”`;
  if (mode === 'below') return 'price target';
  return 'any change';
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "5 min ago", "in 2 hours", "just now". */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? 'just now' : 'in a moment';
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });
  for (const [unit, size] of units) {
    if (abs >= size || unit === 'minute') return format.format(Math.round(diff / size), unit);
  }
  return '';
}

/** "Sep 27, 14:05" for change history. */
export function dateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function plural(count: number, word: string): string {
  if (count === 1) return `${count} ${word}`;
  return `${count} ${word}${/(?:s|x|z|ch|sh)$/.test(word) ? 'es' : 's'}`;
}
