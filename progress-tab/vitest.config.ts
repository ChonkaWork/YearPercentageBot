import { defineConfig } from 'vitest/config';

/**
 * Date math runs in the local time zone, so the time-zone suite (test/zones/) runs once per zone
 * below. Each project sets TZ for its worker; the suite asserts the zone really applied.
 *
 *  - UTC: no DST at all
 *  - Europe/Kyiv: 23 h day in March, 25 h day in October (at 03:00/04:00)
 *  - America/New_York: DST at 02:00, other dates than Europe
 *  - America/Santiago: DST starts at midnight, so some days begin at 01:00
 *  - Australia/Lord_Howe: 30-minute DST shift (23.5 h and 24.5 h days)
 *  - Asia/Kolkata: +05:30, no DST
 *
 * Add a zone for one run: TEST_TZ=Asia/Tokyo npm test
 */
const zones = ['UTC', 'Europe/Kyiv', 'America/New_York', 'America/Santiago', 'Australia/Lord_Howe', 'Asia/Kolkata'];
if (process.env.TEST_TZ && !zones.includes(process.env.TEST_TZ)) zones.push(process.env.TEST_TZ);

export default defineConfig({
  define: { __E2E__: 'false' },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/*.test.ts'], env: { TZ: 'UTC' } },
      },
      ...zones.map((zone) => ({
        extends: true,
        test: { name: `tz:${zone}`, include: ['test/zones/*.test.ts'], env: { TZ: zone } },
      })),
    ],
  },
});
