import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  describeDays,
  describeSchedule,
  formatTime,
  formatWhen,
  isInWindow,
  isValidTimeZone,
  nextChange,
  parseTime,
  sanitizeSchedule,
  scheduleAllows,
  zonedTime,
  type Schedule,
} from '../src/core/schedule';

const MINUTE = 60_000;
/** Build a UTC instant: 2026-09-28 is a Monday. */
const utc = (day: number, time: string) => Date.parse(`2026-09-${String(27 + day).padStart(2, '0')}T${time}:00Z`);
// day 0 = Sun 27, 1 = Mon 28, … 6 = Sat Oct 3 (handled below)
const at = (weekday: number, time: string) => {
  const base = Date.parse('2026-09-27T00:00:00Z'); // Sunday
  const [h, m] = time.split(':').map(Number) as [number, number];
  return base + weekday * 1440 * MINUTE + (h * 60 + m) * MINUTE;
};

function schedule(patch: Partial<Schedule>): Schedule {
  return { ...DEFAULT_SCHEDULE, days: [...DEFAULT_SCHEDULE.days], enabled: true, timeZone: 'UTC', ...patch };
}

describe('time parsing and formatting', () => {
  it('parses H:MM and HH:MM, rejects the rest', () => {
    expect(parseTime('09:30')).toBe(570);
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime(' 23:59 ')).toBe(1439);
    expect(parseTime('00:00')).toBe(0);
    for (const bad of ['24:00', '12:60', '1230', '', 'noon', '12:3', null, 5]) expect(parseTime(bad)).toBeNull();
  });

  it('formats minutes as HH:MM and wraps', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(570)).toBe('09:30');
    expect(formatTime(1439)).toBe('23:59');
    expect(formatTime(1440)).toBe('00:00');
    expect(formatTime(-60)).toBe('23:00');
  });
});

describe('time zones', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('reads weekday and minute in a zone', () => {
    const instant = utc(1, '23:30'); // Mon 23:30 UTC
    expect(zonedTime(instant, 'UTC')).toEqual({ day: 1, minute: 23 * 60 + 30 });
    // Kyiv is UTC+3 in September: already Tuesday 02:30.
    expect(zonedTime(instant, 'Europe/Kyiv')).toEqual({ day: 2, minute: 150 });
    // New York is UTC−4: Monday 19:30.
    expect(zonedTime(instant, 'America/New_York')).toEqual({ day: 1, minute: 19 * 60 + 30 });
    // Midnight is 0, not 24 (h23 cycle).
    expect(zonedTime(utc(1, '00:00'), 'UTC')).toEqual({ day: 1, minute: 0 });
  });
});

describe('sanitizeSchedule', () => {
  it('falls back per field', () => {
    expect(sanitizeSchedule(undefined)).toEqual(DEFAULT_SCHEDULE);
    expect(sanitizeSchedule({ enabled: 'yes', days: 'mon', start: 5000, end: -1, timeZone: 'Nowhere/Land' })).toEqual(DEFAULT_SCHEDULE);
  });

  it('keeps valid values, de-duplicates and sorts days, accepts "HH:MM" strings', () => {
    expect(sanitizeSchedule({ enabled: true, days: [5, 1, 1, 9, -1, 2.5, 0], start: '22:00', end: 360, timeZone: 'Asia/Tokyo' })).toEqual({
      enabled: true,
      days: [0, 1, 5],
      start: 1320,
      end: 360,
      timeZone: 'Asia/Tokyo',
    });
  });

  it('allows an empty day list (never on)', () => {
    expect(sanitizeSchedule({ days: [] }).days).toEqual([]);
  });
});

describe('isInWindow', () => {
  const work = schedule({ days: [1, 2, 3, 4, 5], start: 540, end: 1020 });

  it('same-day window: start inclusive, end exclusive, only chosen days', () => {
    expect(isInWindow(work, at(3, '08:59'))).toBe(false);
    expect(isInWindow(work, at(3, '09:00'))).toBe(true);
    expect(isInWindow(work, at(3, '16:59'))).toBe(true);
    expect(isInWindow(work, at(3, '17:00'))).toBe(false);
    expect(isInWindow(work, at(6, '10:00'))).toBe(false); // Saturday
    expect(isInWindow(work, at(0, '10:00'))).toBe(false); // Sunday
  });

  it('overnight window belongs to the day it starts on', () => {
    const night = schedule({ days: [5], start: 22 * 60, end: 6 * 60 }); // Friday 22:00 → Saturday 06:00
    expect(isInWindow(night, at(5, '21:59'))).toBe(false);
    expect(isInWindow(night, at(5, '22:00'))).toBe(true);
    expect(isInWindow(night, at(5, '23:59'))).toBe(true);
    expect(isInWindow(night, at(6, '00:00'))).toBe(true);
    expect(isInWindow(night, at(6, '05:59'))).toBe(true);
    expect(isInWindow(night, at(6, '06:00'))).toBe(false);
    expect(isInWindow(night, at(6, '23:00'))).toBe(false); // Saturday isn't chosen
    expect(isInWindow(night, at(5, '02:00'))).toBe(false); // Thursday night isn't chosen
  });

  it('overnight across the week boundary (Saturday night → Sunday morning)', () => {
    const night = schedule({ days: [6], start: 23 * 60, end: 60 });
    expect(isInWindow(night, at(6, '23:30'))).toBe(true);
    expect(isInWindow(night, at(7, '00:30'))).toBe(true); // next Sunday
    expect(isInWindow(night, at(0, '00:30'))).toBe(true); // this Sunday follows the previous Saturday
    expect(isInWindow(night, at(7, '01:00'))).toBe(false);
  });

  it('start === end means all day on the chosen days', () => {
    const allDay = schedule({ days: [0, 6], start: 0, end: 0 });
    expect(isInWindow(allDay, at(6, '00:00'))).toBe(true);
    expect(isInWindow(allDay, at(0, '23:59'))).toBe(true);
    expect(isInWindow(allDay, at(1, '12:00'))).toBe(false);
  });

  it('no days: never', () => {
    expect(isInWindow(schedule({ days: [] }), at(2, '10:00'))).toBe(false);
  });

  it('uses the schedule time zone', () => {
    const kyiv = schedule({ days: [1], start: 9 * 60, end: 10 * 60, timeZone: 'Europe/Kyiv' });
    expect(isInWindow(kyiv, utc(1, '06:30'))).toBe(true); // 09:30 in Kyiv
    expect(isInWindow(kyiv, utc(1, '09:30'))).toBe(false); // 12:30 in Kyiv
    const ny = schedule({ days: [1], start: 22 * 60, end: 2 * 60, timeZone: 'America/New_York' });
    expect(isInWindow(ny, utc(2, '03:00'))).toBe(true); // Mon 23:00 in New York
    expect(isInWindow(ny, utc(2, '06:30'))).toBe(false); // Tue 02:30 in New York
  });

  it('scheduleAllows ignores the window while disabled', () => {
    const off = { ...work, enabled: false };
    expect(scheduleAllows(off, at(6, '03:00'))).toBe(true);
    expect(scheduleAllows(work, at(6, '03:00'))).toBe(false);
    expect(scheduleAllows(work, at(1, '10:00'))).toBe(true);
  });
});

describe('nextChange', () => {
  const work = schedule({ days: [1, 2, 3, 4, 5], start: 540, end: 1020 });

  it('finds the end of the current window and the next start', () => {
    expect(nextChange(work, at(3, '10:15'))).toBe(at(3, '17:00'));
    expect(nextChange(work, at(3, '17:00'))).toBe(at(4, '09:00'));
    expect(nextChange(work, at(5, '18:00'))).toBe(at(8, '09:00')); // Friday evening → Monday
    expect(nextChange(work, at(3, '08:59') + 30_000)).toBe(at(3, '09:00'));
  });

  it('handles overnight windows', () => {
    const night = schedule({ days: [5], start: 22 * 60, end: 6 * 60 });
    expect(nextChange(night, at(5, '12:00'))).toBe(at(5, '22:00'));
    expect(nextChange(night, at(5, '23:00'))).toBe(at(6, '06:00'));
  });

  it('all-day windows change at midnight; never-changing schedules return null', () => {
    const weekend = schedule({ days: [0, 6], start: 0, end: 0 });
    expect(nextChange(weekend, at(5, '15:00'))).toBe(at(6, '00:00'));
    expect(nextChange(weekend, at(6, '15:00'))).toBe(at(8, '00:00'));
    expect(nextChange(schedule({ days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 0 }), at(1, '00:00'))).toBeNull();
    expect(nextChange(schedule({ days: [] }), at(1, '00:00'))).toBeNull();
  });

  it('is right across a DST change', () => {
    // Europe/Berlin leaves DST on Sunday 2026-10-25 at 03:00 local (01:00 UTC).
    const sunday = schedule({ days: [0], start: 9 * 60, end: 10 * 60, timeZone: 'Europe/Berlin' });
    const saturdayNoonUtc = Date.parse('2026-10-24T12:00:00Z'); // 14:00 CEST
    // 09:00 CET on Sunday = 08:00 UTC.
    expect(nextChange(sunday, saturdayNoonUtc)).toBe(Date.parse('2026-10-25T08:00:00Z'));
    // New York enters DST on Sunday 2027-03-14 at 02:00 local.
    const ny = schedule({ days: [0], start: 12 * 60, end: 13 * 60, timeZone: 'America/New_York' });
    expect(nextChange(ny, Date.parse('2027-03-13T20:00:00Z'))).toBe(Date.parse('2027-03-14T16:00:00Z')); // 12:00 EDT
    // A start inside the skipped hour (02:30 doesn't exist that night): focus starts at 03:00 EDT.
    const skipped = schedule({ days: [0], start: 150, end: 240, timeZone: 'America/New_York' });
    expect(nextChange(skipped, Date.parse('2027-03-13T20:00:00Z'))).toBe(Date.parse('2027-03-14T07:00:00Z'));
  });
});

describe('descriptions', () => {
  it('describes days compactly, Monday first', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeDays([0, 6])).toBe('Sat, Sun');
    expect(describeDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(describeDays([0, 1, 2, 4, 5, 6])).toBe('Mon, Tue, Thu–Sun');
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(describeDays([])).toBe('No days');
  });

  it('describes the schedule', () => {
    expect(describeSchedule(schedule({}))).toBe('Mon–Fri · 09:00–17:00');
    expect(describeSchedule(schedule({ days: [5], start: 1320, end: 360 }))).toBe('Fri · 22:00–06:00 (overnight)');
    expect(describeSchedule(schedule({ days: [0, 6], start: 0, end: 0 }))).toBe('Sat, Sun · all day');
  });

  it('formats a moment relative to now', () => {
    const now = at(3, '10:00');
    expect(formatWhen(at(3, '17:00'), now, 'UTC')).toBe('17:00');
    expect(formatWhen(at(4, '09:00'), now, 'UTC')).toBe('tomorrow 09:00');
    expect(formatWhen(at(8, '09:00'), now, 'UTC')).toBe('Mon 09:00');
    expect(formatWhen(at(3, '10:15'), now, 'Europe/Kyiv')).toBe('13:15');
  });
});
