import { describe, expect, it } from 'vitest';
import type { Countdown } from '../src/core/countdown';
import { describeLife } from '../src/core/life';
import {
  SHARE_BLOCKS,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  blockBar,
  countdownCard,
  filledBlocks,
  lifeCard,
  monthCard,
  shareCardText,
  slug,
  yearCard,
} from '../src/core/share';

// Pinned to UTC like the other zone-independent tests.
const local = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss);
const NOW = local(2026, 10, 16, 9, 41);
const options = { weekStart: 'monday' as const, decimals: 2 };

describe('the Telegram-style bar', () => {
  it('has 20 blocks, rounded down like the percentages', () => {
    expect(SHARE_BLOCKS).toBe(20);
    expect([SHARE_WIDTH, SHARE_HEIGHT]).toEqual([1200, 630]);
    expect(blockBar(0.79)).toBe('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░');
    expect(blockBar(0)).toBe('░'.repeat(20));
    expect(blockBar(1)).toBe('▓'.repeat(20));
    expect(filledBlocks(0.0499)).toBe(0);
    expect(filledBlocks(0.05)).toBe(1);
    expect(filledBlocks(0.15)).toBe(3);
    // The last block fills only when it's over.
    expect(filledBlocks(0.99999)).toBe(19);
    expect(filledBlocks(Number.NaN)).toBe(0);
    expect(filledBlocks(3)).toBe(20);
    expect(blockBar(0.5, 10)).toBe('▓▓▓▓▓░░░░░');
  });
});

describe('cards', () => {
  it('year: "2026 is 79.00% complete"', () => {
    const card = yearCard(NOW, options);
    expect(card).toMatchObject({
      kind: 'year',
      eyebrow: 'Year progress',
      headline: '2026 is 79.01% complete',
      emphasis: '79.01%',
      blocks: 15,
      bar: '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░',
      caption: 'Day 289 of 365 · 76 days 14 h left',
      dateline: 'Friday, October 16, 2026',
      fileName: 'progress-tab-2026.png',
    });
    expect(yearCard(local(2026, 12, 31, 23, 59, 59), options).headline).toBe('2026 is 99.99% complete');
    expect(yearCard(local(2027, 1, 1), options)).toMatchObject({ headline: '2027 is 0.00% complete', blocks: 0 });
    expect(shareCardText(card)).toBe('2026 is 79.01% complete · ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ · Day 289 of 365 · 76 days 14 h left');
  });

  it('month', () => {
    expect(monthCard(NOW, { ...options, decimals: 1 })).toMatchObject({
      headline: 'October 2026 is 49.6% complete',
      emphasis: '49.6%',
      blocks: 9,
      caption: 'Day 16 of 31 · 15 days 14 h left',
      fileName: 'progress-tab-october-2026.png',
    });
  });

  it('life in weeks never shows the birth date', () => {
    const view = describeLife({ birthDate: '1990-05-01', years: 80 }, NOW, 2)!;
    const card = lifeCard(view, NOW);
    expect(card).toMatchObject({
      kind: 'life',
      headline: `${view.percent.text} of 80 years lived`,
      emphasis: view.percent.text,
      blocks: 9,
      fileName: 'progress-tab-life-in-weeks.png',
    });
    expect(card.caption).toMatch(/^[\d,]+ weeks lived, about [\d,]+ left of 80 years\.$/);
    expect(shareCardText(card)).not.toMatch(/1990|May/);
  });

  it('countdown: the wait so far, even when the list hides its bar', () => {
    const flight: Countdown = {
      id: 'f',
      name: 'Flight to Lisbon',
      date: '2026-10-23',
      time: '07:45',
      createdAt: local(2026, 10, 1, 20).getTime(),
      showProgress: false,
      repeat: 'none',
    };
    const card = countdownCard(flight, NOW, { hour12: false, decimals: 1 })!;
    expect(card).toMatchObject({
      kind: 'countdown',
      eyebrow: 'Countdown',
      headline: 'Flight to Lisbon in 6 days 22 h',
      emphasis: '6 days 22 h',
      caption: 'Fri, Oct 23, 2026 · 07:45 · 67.8% of the wait is over',
      fileName: 'progress-tab-flight-to-lisbon.png',
    });
    expect(card.blocks).toBe(13);
    const birthday: Countdown = { ...flight, name: 'Mom’s birthday', date: '1960-10-16', time: null, repeat: 'yearly' };
    expect(countdownCard(birthday, NOW, { hour12: false, decimals: 1 })).toMatchObject({
      headline: 'Mom’s birthday is today',
      emphasis: 'today',
      fraction: null,
      bar: '',
      caption: 'Fri, Oct 16, 2026 · every year',
      fileName: 'progress-tab-mom-s-birthday.png',
    });
    const passed = countdownCard({ ...flight, date: '2026-10-09' }, NOW, { hour12: false, decimals: 1 });
    expect(passed).toMatchObject({ headline: 'Flight to Lisbon: passed 7 days ago', emphasis: '', fraction: null });
    expect(countdownCard({ ...flight, date: 'soon' }, NOW, { hour12: false, decimals: 1 })).toBeNull();
  });

  it('makes safe ASCII file names', () => {
    expect(slug('Mom’s birthday 🎂')).toBe('mom-s-birthday');
    expect(slug('Café in Kraków')).toBe('cafe-in-krakow');
    expect(slug('Відпустка')).toBe('');
    expect(slug('x'.repeat(60))).toHaveLength(48);
  });
});
