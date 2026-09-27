import { describe, expect, it } from 'vitest';
import { describeClock, describePeriod, dstNote } from '../../src/core/periods';
import { local } from './helpers';

const opts = { weekStart: 'monday' as const, decimals: 1 };

describe('describePeriod', () => {
  const now = local(2026, 9, 27, 12); // Sunday

  it('labels and captions each period', () => {
    expect(describePeriod('year', now, { ...opts, decimals: 2 })).toMatchObject({ label: '2026', caption: 'Day 270 of 365', remainingText: '95 days 12 h left' });
    expect(describePeriod('month', now, opts)).toMatchObject({ label: 'September', caption: 'Day 27 of 30', remainingText: '3 days 12 h left' });
    expect(describePeriod('week', now, opts)).toMatchObject({ label: 'This week', caption: 'Sep 21 – 27', remainingText: '12 h left' });
    expect(describePeriod('week', now, { ...opts, weekStart: 'sunday' })).toMatchObject({ caption: 'Sep 27 – Oct 3', remainingText: '6 days 12 h left' });
    expect(describePeriod('day', now, opts)).toMatchObject({ label: 'Today', caption: 'Sunday', remainingText: '12 h left' });
  });

  it('handles the last second of the year', () => {
    const last = local(2026, 12, 31, 23, 59, 59);
    const year = describePeriod('year', last, { ...opts, decimals: 2 });
    expect(year.percent.text).toBe('99.99%');
    expect(year.remainingText).toBe('1 s left');
    expect(year.caption).toBe('Day 365 of 365');
    expect(describePeriod('month', last, opts).percent.text).toBe('99.9%');
    expect(describePeriod('day', last, opts).percent.text).toBe('99.9%');
    expect(describePeriod('day', last, { ...opts, decimals: 4 }).percent.text).toBe('99.9988%');
  });

  it('starts over at exactly midnight on January 1', () => {
    const first = local(2027, 1, 1);
    const year = describePeriod('year', first, { ...opts, decimals: 2 });
    expect(year).toMatchObject({ label: '2027', caption: 'Day 1 of 365', remainingText: '365 days left', fraction: 0 });
    expect(year.percent.text).toBe('0.00%');
    expect(describePeriod('month', first, opts)).toMatchObject({ label: 'January', caption: 'Day 1 of 31', remainingText: '31 days left' });
    expect(describePeriod('day', first, opts)).toMatchObject({ caption: 'Friday', remainingText: '1 day left' });
    // Jan 1, 2027 is a Friday: the Monday week began in 2026.
    expect(describePeriod('week', first, opts).caption).toBe('Dec 28, 2026 – Jan 3, 2027');
  });

  it('knows leap years', () => {
    expect(describePeriod('year', local(2024, 12, 31, 12), opts).caption).toBe('Day 366 of 366');
    expect(describePeriod('month', local(2024, 2, 29, 12), opts).caption).toBe('Day 29 of 29');
    expect(describePeriod('month', local(2026, 2, 28, 12), opts).caption).toBe('Day 28 of 28');
  });
});

describe('dstNote', () => {
  it('is empty on normal days', () => {
    expect(dstNote(86_400_000)).toBe('');
    expect(dstNote(82_800_000)).toBe(' · 23-hour day, clocks go forward');
    expect(dstNote(90_000_000)).toBe(' · 25-hour day, clocks go back');
  });
});

describe('describeClock', () => {
  it('formats time and date', () => {
    expect(describeClock(local(2026, 9, 27, 14, 5, 59), false)).toEqual({ time: '14:05', date: 'Sunday, September 27' });
    expect(describeClock(local(2026, 9, 27, 14, 5), true).time).toBe('2:05 PM');
    expect(describeClock(local(2026, 9, 27, 0, 0), true).time).toBe('12:00 AM');
    expect(describeClock(local(2026, 9, 27, 0, 0), false).time).toBe('00:00');
  });
});
