// Writes the CLOB price-history fixtures (fixtures/clob/<market-slug>.<range>.json) in the
// documented /prices-history format: { "history": [ { "t": <unix seconds>, "p": <price> } ] }.
//
//   node scripts/make-fixture-history.mjs
//
// The Gamma fixtures (fixtures/gamma/events/*.json) are hand-written. Price histories are long
// numeric series, so they are generated here, deterministically, from each market's hand-written
// numbers: the path passes exactly through the current price, the price 24 h ago
// (price - oneDayPriceChange) and 7 days ago (price - oneWeekPriceChange), so analyses derived
// from history agree with the Gamma fields. A few markets get hand-made shapes (a sudden jump,
// a slide). Timestamps end at FIXTURE_NOW; the e2e server shifts them to the current time.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_NOW = 1_790_000_000; // 2026-09-21T14:13:20Z, unix seconds
const HOUR = 3600;
const STEP = 600; // 10-minute base grid

const RANGES = {
  '24h': { hours: 24, step: 600 }, // interval=1d, fidelity=10
  '7d': { hours: 168, step: 3600 }, // interval=1w, fidelity=60
  '30d': { hours: 720, step: 21600 }, // interval=1m, fidelity=360
};

/** Hand-made shapes: [hours ago, price] knots, plus noise amplitude. */
const SHAPES = {
  // Sudden +8 pp within one hour, 5-6 hours ago, reversing a slide over the prior days.
  'will-us-q3-2026-gdp-growth-exceed-2-percent': {
    knots: [[720, 0.55], [168, 0.62], [60, 0.6], [24, 0.586], [6, 0.6], [5, 0.68], [0, 0.71]],
    noise: 0.004,
    pinned: [168, 24, 6, 5, 0],
  },
  // A choppy slide.
  'will-bitcoin-close-2026-above-150000': {
    knots: [[720, 0.34], [168, 0.301], [96, 0.29], [24, 0.255], [10, 0.23], [3, 0.19], [0, 0.18]],
    noise: 0.012,
    pinned: [168, 24, 0],
  },
};

/** Markets whose CLOB history is empty (tests the "missing history" path). */
const EMPTY = new Set(['will-a-private-lunar-lander-touch-down-in-2026']);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function interpolate(knots, hoursAgo) {
  const sorted = [...knots].sort((a, b) => b[0] - a[0]);
  if (hoursAgo >= sorted[0][0]) return sorted[0][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [h1, p1] = sorted[i];
    const [h2, p2] = sorted[i + 1];
    if (hoursAgo <= h1 && hoursAgo >= h2) return p1 + ((h1 - hoursAgo) / (h1 - h2)) * (p2 - p1);
  }
  return sorted[sorted.length - 1][1];
}

function buildPath(market) {
  const price = Number(JSON.parse(market.outcomePrices)[0]);
  const shape = SHAPES[market.slug] ?? {
    knots: [
      [720, price - (market.oneMonthPriceChange ?? market.oneWeekPriceChange * 1.5)],
      [168, price - market.oneWeekPriceChange],
      [24, price - market.oneDayPriceChange],
      [0, price],
    ],
    noise: market.liquidityNum < 10_000 ? 0.002 : 0.004,
    pinned: [168, 24, 0],
  };
  const random = mulberry32(hash(market.slug));
  const steps = (720 * HOUR) / STEP;
  const phi = 0.97;
  const sigma = shape.noise * Math.sqrt(1 - phi * phi);
  let noise = 0;
  const path = new Map();
  for (let i = steps; i >= 0; i--) {
    noise = phi * noise + sigma * gaussian(random);
    const hoursAgo = (i * STEP) / HOUR;
    const distance = Math.min(...shape.pinned.map((pin) => Math.abs(pin - hoursAgo)));
    const taper = Math.min(1, distance / 2);
    const value = interpolate(shape.knots, hoursAgo) + noise * taper;
    path.set(i * STEP, Math.min(0.9985, Math.max(0.0015, Math.round(value * 10000) / 10000)));
  }
  return path;
}

const eventsDir = join(root, 'fixtures/gamma/events');
const outDir = join(root, 'fixtures/clob');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let files = 0;
for (const name of (await readdir(eventsDir)).sort()) {
  const [event] = JSON.parse(await readFile(join(eventsDir, name), 'utf8'));
  for (const market of event.markets ?? []) {
    if (market.closed || typeof market.clobTokenIds !== 'string') continue;
    const path = EMPTY.has(market.slug) ? null : buildPath(market);
    for (const [range, { hours, step }] of Object.entries(RANGES)) {
      const history = [];
      if (path) {
        for (let secondsAgo = hours * HOUR; secondsAgo >= 0; secondsAgo -= step) {
          history.push({ t: FIXTURE_NOW - secondsAgo, p: path.get(secondsAgo) });
        }
      }
      await writeFile(join(outDir, `${market.slug}.${range}.json`), `${JSON.stringify({ history })}\n`);
      files++;
    }
  }
}
console.log(`Wrote ${files} history fixtures to fixtures/clob/`);
