import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onNotificationClicked, runAlertCheck, syncAlarm } from '../src/background/alerts';
import { ALERT_ALARM, ALERT_PERIOD_MINUTES, FORBIDDEN_NOTIFICATION_WORDS, MAX_MARKETS_PER_CHECK, RATE_LIMIT_BACKOFF_MS } from '../src/core/alertCheck';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '../src/core/alerts';
import type { MarketSummary, WatchItem } from '../src/core/saved';
import { eventPayload } from './helpers';

/**
 * The service worker's alert run (src/background/alerts.ts) with an in-memory chrome.* and a
 * fetch that answers with the Gamma fixtures. Covers what the e2e test can't easily vary:
 * budgets, rate limits, stale data, the cache.
 */

const MIN = 60_000;
const EV_EVENT = 'ev-sales-20m-2026';
const EV_MARKET = 'will-global-ev-sales-exceed-20-million-in-2026';

interface FakeChrome {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  alarms: Map<string, { name: string; periodInMinutes?: number; scheduledTime: number }>;
  notifications: Map<string, chrome.notifications.NotificationOptions>;
  openPopup: ReturnType<typeof vi.fn>;
}

function installFakeChrome(): FakeChrome {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (data: Record<string, unknown>) => ({
    async get(key: string | null) {
      if (key === null) return structuredClone(data);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  });
  const alarms = new Map<string, { name: string; periodInMinutes?: number; scheduledTime: number }>();
  const notifications = new Map<string, chrome.notifications.NotificationOptions>();
  const openPopup = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {
    storage: { local: area(local), session: area(session) },
    alarms: {
      get: async (name: string) => alarms.get(name),
      create: async (name: string, info: { delayInMinutes?: number; periodInMinutes?: number }) => {
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes, scheduledTime: Date.now() + (info.delayInMinutes ?? 0) * MIN });
      },
      clear: async (name: string) => alarms.delete(name),
    },
    notifications: {
      create: async (id: string, options: chrome.notifications.NotificationOptions) => {
        notifications.set(id, options);
        return id;
      },
      clear: async (id: string) => notifications.delete(id),
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    action: { openPopup, setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    windows: { getLastFocused: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => ({})) },
  });
  return { local, session, alarms, notifications, openPopup };
}

/** Fixture API: every event slug answers with the EV event, at `price` (Yes). */
function installFetch(options: { price?: number; status?: number } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string) => {
    calls.push(input);
    if (options.status) return new Response(JSON.stringify({ error: 'nope' }), { status: options.status, headers: { 'retry-after': '60' } });
    const payload = structuredClone(eventPayload(EV_EVENT)) as { markets: { outcomePrices: string }[] }[];
    if (options.price !== undefined) payload[0]!.markets[0]!.outcomePrices = JSON.stringify([String(options.price), String(Math.round((1 - options.price) * 1000) / 1000)]);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const summary = (overrides: Partial<MarketSummary> = {}): MarketSummary => ({
  probability: 0.624,
  change24h: 0.031,
  change7d: 0.054,
  volume24h: 245_120.44,
  liquidity: 1_180_000,
  signal: 'POSITIVE',
  strength: 60,
  at: Date.now() - 20 * MIN,
  ...overrides,
});

const watch = (eventSlug: string, marketSlug: string | null, overrides: Partial<WatchItem> = {}, settings: Partial<AlertSettings> = {}): WatchItem => ({
  key: `${eventSlug}/${marketSlug ?? ''}`,
  ref: { eventSlug, marketSlug },
  title: 'Will global EV sales exceed 20 million in 2026?',
  outcome: 'Yes',
  addedAt: 1,
  last: summary(),
  previous: null,
  alerts: [],
  alertSettings: { ...DEFAULT_ALERT_SETTINGS, enabled: true, ...settings },
  ...overrides,
});

let fake: FakeChrome;

beforeEach(() => {
  vi.unstubAllGlobals();
  fake = installFakeChrome();
});

describe('background alert check', () => {
  it('a move over the threshold: one request, one notification with the title and numbers', async () => {
    const calls = installFetch({ price: 0.7 });
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    const result = await runAlertCheck();
    expect(result).toEqual({ status: 'done', checked: 1, notified: 1, failed: 0 });
    expect(calls).toEqual([`https://gamma-api.polymarket.com/events?slug=${EV_EVENT}`]);

    const [id, notification] = [...fake.notifications][0]!;
    expect(id).toMatch(new RegExp(`^pm-alert\\|${EV_EVENT}/${EV_MARKET}\\|\\d+$`));
    expect(notification).toMatchObject({ type: 'basic', title: 'Will global EV sales exceed 20 million in 2026?', contextMessage: 'Yes · Watchlist alert', iconUrl: 'chrome-extension://test/icons/icon128.png' });
    expect(notification.message).toBe('Moved +7.6 pp since last check (62.4% → 70.0%)');
    expect(`${notification.title} ${notification.message} ${notification.contextMessage}`).not.toMatch(FORBIDDEN_NOTIFICATION_WORDS);

    const [stored] = fake.local.watchlist as WatchItem[];
    expect(stored!.last?.probability).toBe(0.7);
    expect(stored!.previous?.probability).toBe(0.624);
    expect(stored!.alerts).toEqual(['Moved +7.6 pp since last check (62.4% → 70.0%)']);
    expect(fake.local.alertCheck).toMatchObject({ checked: 1, notified: 1, failed: 0, backoffUntil: null });
  });

  it('below the threshold: the check is recorded, no notification', async () => {
    installFetch({ price: 0.64 });
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    expect(await runAlertCheck()).toMatchObject({ checked: 1, notified: 0 });
    expect(fake.notifications.size).toBe(0);
    expect((fake.local.watchlist as WatchItem[])[0]!.last?.probability).toBe(0.64);
  });

  it('per-market settings: a lower threshold alerts, a disabled rule does not', async () => {
    installFetch({ price: 0.64 });
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET, {}, { movePp: 1, volumePct: null, momentumFlip: false })];
    expect(await runAlertCheck()).toMatchObject({ notified: 1 });
    expect([...fake.notifications.values()][0]!.message).toBe('Moved +1.6 pp since last check (62.4% → 64.0%)');
  });

  it('budget: only markets with alerts on, at most MAX_MARKETS_PER_CHECK per run, recent checks skipped', async () => {
    const calls = installFetch({ price: 0.624 });
    fake.local.watchlist = [
      ...Array.from({ length: 12 }, (_, index) => watch(`event-${index}`, null, { last: summary({ at: Date.now() - (30 + index) * MIN }) })),
      watch('alerts-off', null, {}, { enabled: false }),
      watch('checked-just-now', null, { last: summary({ at: Date.now() - MIN }) }),
    ];
    expect(await runAlertCheck()).toMatchObject({ checked: MAX_MARKETS_PER_CHECK });
    expect(calls).toHaveLength(MAX_MARKETS_PER_CHECK);
    expect(calls.some((url) => /alerts-off|checked-just-now/.test(url))).toBe(false);
    // Oldest first: event-11 … event-2; event-0 and event-1 wait for the next run.
    expect(calls[0]).toContain('slug=event-11');
    expect(calls.some((url) => /slug=event-[01]$/.test(url))).toBe(false);
  });

  it('cache-aware: a market the popup fetched within 60 s is not requested again', async () => {
    const calls = installFetch({ price: 0.7 });
    fake.session[`cache:gamma:event:${EV_EVENT}`] = { value: eventPayload(EV_EVENT), storedAt: Date.now() - 10_000 };
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    expect(await runAlertCheck()).toMatchObject({ checked: 1, notified: 0 });
    expect(calls).toEqual([]);
  });

  it('rate limited: stops, backs off for at least 30 min, next run makes no request', async () => {
    const calls = installFetch({ status: 429 });
    fake.local.watchlist = [watch('event-a', null), watch('event-b', null, { last: summary({ at: Date.now() - 25 * MIN }) })];
    const before = Date.now();
    expect(await runAlertCheck()).toMatchObject({ status: 'done', checked: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    const state = fake.local.alertCheck as { backoffUntil: number; lastError: string };
    expect(state.backoffUntil).toBeGreaterThanOrEqual(before + RATE_LIMIT_BACKOFF_MS);
    expect(state.lastError).toBe('Too many requests');
    expect(await runAlertCheck()).toMatchObject({ status: 'backing-off' });
    expect(calls).toHaveLength(1);
  });

  it('a failed refresh served from an older cache entry is not a new observation', async () => {
    installFetch({ status: 503 });
    fake.session[`cache:gamma:event:${EV_EVENT}`] = { value: eventPayload(EV_EVENT), storedAt: Date.now() - 5 * MIN };
    const item = watch(EV_EVENT, EV_MARKET, { last: summary({ probability: 0.5 }) });
    fake.local.watchlist = [item];
    expect(await runAlertCheck()).toMatchObject({ checked: 0, notified: 0, failed: 1 });
    expect((fake.local.watchlist as WatchItem[])[0]!.last).toEqual(item.last);
    expect(fake.notifications.size).toBe(0);
  });

  it('overlapping triggers share one run', async () => {
    const calls = installFetch({ price: 0.7 });
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    const [first, second] = await Promise.all([runAlertCheck(), runAlertCheck()]);
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(fake.notifications.size).toBe(1);
  });
});

describe('alarm and notification click', () => {
  it('the alarm exists only while a market has alerts on', async () => {
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET, {}, { enabled: false })];
    expect(await syncAlarm()).toBe(false);
    expect(fake.alarms.size).toBe(0);
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    expect(await syncAlarm()).toBe(true);
    expect(fake.alarms.get(ALERT_ALARM)).toMatchObject({ periodInMinutes: ALERT_PERIOD_MINUTES });
    const scheduled = fake.alarms.get(ALERT_ALARM)!.scheduledTime;
    await syncAlarm();
    expect(fake.alarms.get(ALERT_ALARM)!.scheduledTime).toBe(scheduled);
    fake.local.watchlist = [];
    expect(await syncAlarm()).toBe(false);
    expect(fake.alarms.size).toBe(0);
  });

  it('clicking an alert opens the popup with that market', async () => {
    fake.local.watchlist = [watch(EV_EVENT, EV_MARKET)];
    fake.notifications.set(`pm-alert|${EV_EVENT}/${EV_MARKET}|1`, { type: 'basic', title: 't', message: 'm', iconUrl: 'i' });
    await onNotificationClicked(`pm-alert|${EV_EVENT}/${EV_MARKET}|1`);
    expect(fake.session.pending).toMatchObject({ kind: 'analyze', url: `https://polymarket.com/event/${EV_EVENT}/${EV_MARKET}` });
    expect(fake.openPopup).toHaveBeenCalledOnce();
    expect(fake.notifications.size).toBe(0);
  });

  it('a removed market still opens from its notification; other ids are ignored', async () => {
    await onNotificationClicked('pm-alert|some-event/|5');
    expect(fake.session.pending).toMatchObject({ url: 'https://polymarket.com/event/some-event' });
    delete fake.session.pending;
    await onNotificationClicked('another-extension-id');
    expect(fake.session.pending).toBeUndefined();
  });
});
