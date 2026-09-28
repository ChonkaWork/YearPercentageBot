/**
 * Focus schedule (Pro): focus mode is on only during chosen days and hours. Pure.
 *
 * A window starts on each chosen day at `start` and ends at `end`. When `end` is not after
 * `start` the window runs overnight and ends the next morning (22:00–06:00 chosen for Friday
 * covers Friday night into Saturday 06:00). `start === end` means the whole day.
 * Times are read in `timeZone` (an IANA name), or in this computer's zone when it is ''.
 */

export interface Schedule {
  enabled: boolean;
  /** Days a window starts on: 0 = Sunday … 6 = Saturday. Sorted, unique. */
  days: number[];
  /** Minutes after midnight, 0–1439. */
  start: number;
  /** Minutes after midnight, 0–1439. Not after `start`: overnight (equal: all day). */
  end: number;
  /** IANA time zone, or '' for the browser's own. */
  timeZone: string;
}

export const MINUTES_PER_DAY = 1440;
const MINUTE = 60_000;

export const DEFAULT_SCHEDULE: Readonly<Schedule> = Object.freeze({
  enabled: false,
  days: [1, 2, 3, 4, 5],
  start: 9 * 60,
  end: 17 * 60,
  timeZone: '',
});

/** Short names, Sunday first (same index as Date#getDay). */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Display order: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Day of week and minute of day of `now` in `timeZone` ('' = local). */
export function zonedTime(now: number, timeZone: string): { day: number; minute: number } {
  const parts = formatter(timeZone).formatToParts(new Date(now));
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') day = Math.max(0, DAY_NAMES.indexOf(part.value as (typeof DAY_NAMES)[number]));
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { day, minute: hour * 60 + minute };
}

/** "09:30" → 570. Accepts H:MM and HH:MM (24 h); anything else is null. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 570 → "09:30". */
export function formatTime(minutes: number): string {
  const value = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function sanitizeMinute(value: unknown, fallback: number): number {
  if (typeof value === 'string') return parseTime(value) ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) return fallback;
  return value;
}

export function sanitizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_SCHEDULE.days];
  const days = new Set<number>();
  for (const day of value) if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day as number);
  return [...days].sort((a, b) => a - b);
}

export function sanitizeSchedule(raw: unknown): Schedule {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SCHEDULE.enabled,
    days: sanitizeDays(input.days),
    start: sanitizeMinute(input.start, DEFAULT_SCHEDULE.start),
    end: sanitizeMinute(input.end, DEFAULT_SCHEDULE.end),
    timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : '',
  };
}

/** Whether `now` falls inside a window of the schedule (ignores `enabled`). */
export function isInWindow(schedule: Schedule, now: number): boolean {
  if (schedule.days.length === 0) return false;
  const { day, minute } = zonedTime(now, schedule.timeZone);
  const { start, end, days } = schedule;
  if (start === end) return days.includes(day);
  if (start < end) return days.includes(day) && minute >= start && minute < end;
  // Overnight: the evening of a chosen day, or the morning after one.
  return (days.includes(day) && minute >= start) || (days.includes((day + 6) % 7) && minute < end);
}

/** Whether focus mode should be on at `now` as far as the schedule is concerned. */
export function scheduleAllows(schedule: Schedule, now: number): boolean {
  return !schedule.enabled || isInWindow(schedule, now);
}

/**
 * When `isInWindow` next flips, to the minute, within the next 8 days; null if it never does
 * (no days, or all day every day). Candidate times come from the wall-clock boundaries and
 * are then corrected against real evaluation, so DST shifts don't make it wrong.
 */
export function nextChange(schedule: Schedule, now: number): number | null {
  const { days, start, end } = schedule;
  if (days.length === 0 || (start === end && days.length === 7)) return null;
  const current = isInWindow(schedule, now);
  const { minute } = zonedTime(now, schedule.timeZone);
  const base = Math.floor(now / MINUTE) * MINUTE;
  const boundaries = start === end ? [0] : [start, end];
  const candidates: { delta: number; boundary: number }[] = [];
  for (let offset = 0; offset <= 8; offset += 1) {
    for (const boundary of boundaries) {
      const delta = offset * MINUTES_PER_DAY + boundary - minute;
      if (delta > 0) candidates.push({ delta, boundary });
    }
  }
  candidates.sort((a, b) => a.delta - b.delta);
  for (const { delta, boundary } of candidates) {
    const naive = base + delta * MINUTE;
    // Land on the wall-clock boundary even when a DST change lies in between.
    let diff = boundary - zonedTime(naive, schedule.timeZone).minute;
    if (diff > MINUTES_PER_DAY / 2) diff -= MINUTES_PER_DAY;
    if (diff < -MINUTES_PER_DAY / 2) diff += MINUTES_PER_DAY;
    // A boundary inside a skipped DST hour doesn't exist: then the naive time is past it.
    for (let at of [naive + diff * MINUTE, naive]) {
      if (at <= now || isInWindow(schedule, at) === current) continue;
      // Walk back to the first minute that differs.
      for (let step = 0; step < 180 && at - MINUTE > now && isInWindow(schedule, at - MINUTE) !== current; step += 1) at -= MINUTE;
      return at;
    }
  }
  return null;
}

/** "Mon–Fri", "Mon, Wed, Sat–Sun", "Every day", "No days". */
export function describeDays(days: readonly number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.length === 0) return 'No days';
  const chosen = WEEK_ORDER.filter((day) => days.includes(day));
  const groups: number[][] = [];
  for (const day of chosen) {
    const last = groups.at(-1);
    const index = WEEK_ORDER.indexOf(day);
    if (last && WEEK_ORDER.indexOf(last.at(-1) as (typeof WEEK_ORDER)[number]) === index - 1) last.push(day);
    else groups.push([day]);
  }
  return groups
    .map((group) => {
      const first = DAY_NAMES[group[0] ?? 0];
      if (group.length === 1) return first;
      const last = DAY_NAMES[group.at(-1) ?? 0];
      return group.length === 2 ? `${first}, ${last}` : `${first}–${last}`;
    })
    .join(', ');
}

/** "Mon–Fri · 09:00–17:00", "Fri · 22:00–06:00 (overnight)", "Every day · all day". */
export function describeSchedule(schedule: Schedule): string {
  const hours =
    schedule.start === schedule.end
      ? 'all day'
      : `${formatTime(schedule.start)}–${formatTime(schedule.end)}${schedule.end < schedule.start ? ' (overnight)' : ''}`;
  return `${describeDays(schedule.days)} · ${hours}`;
}

/**
 * A moment relative to `now`, for status lines: "17:00", "tomorrow 09:00", "Mon 09:00".
 * Shown in `timeZone` ('' = local).
 */
export function formatWhen(at: number, now: number, timeZone = ''): string {
  const target = zonedTime(at, timeZone);
  const today = zonedTime(now, timeZone);
  const time = formatTime(target.minute);
  const days = Math.round((at - now) / (MINUTES_PER_DAY * MINUTE));
  if (target.day === today.day && at - now < MINUTES_PER_DAY * MINUTE) return time;
  if (target.day === (today.day + 1) % 7 && days <= 1) return `tomorrow ${time}`;
  return `${DAY_NAMES[target.day]} ${time}`;
}
