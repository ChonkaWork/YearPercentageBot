/** Time zone of this worker, as set by the vitest project (see vitest.config.ts). */
export const zone = process.env.TZ ?? '';

/** Local date/time shorthand; month is 1-based here to keep tests readable. */
export function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second, ms);
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** "2026-09-27 12:00:00" in local time, for readable assertion messages. */
export function fields(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
