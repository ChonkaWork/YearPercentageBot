import { describe, expect, it } from 'vitest';
import {
  alertNotification,
  applyCheck,
  backoffAfterRateLimit,
  FORBIDDEN_NOTIFICATION_WORDS,
  inlineRules,
  isBackingOff,
  keyFromNotificationId,
  marketsToCheck,
  MAX_MARKETS_PER_CHECK,
  MIN_RECHECK_MS,
  needsAlarm,
  notificationId,
  RATE_LIMIT_BACKOFF_MS,
  sanitizeAlertCheckState,
} from '../src/core/alertCheck';
import { DEFAULT_ALERT_RULES, DEFAULT_ALERT_SETTINGS, describeAlertSettings, hasActiveAlerts, rulesFor, sanitizeAlertSettings, type AlertSettings } from '../src/core/alerts';
import { EARLY_ACCESS, effectivePlan, FREE_INCLUDES, hasFeature, HISTORY_LIMIT, isPlan, limitsFor, PRO_FEATURE_INFO, PRO_FEATURES, PRO_PRICE, watchlistLimitMessage } from '../src/core/plan';
import { addToWatchlist, sanitizeWatchlist, type MarketSummary, type WatchItem } from '../src/core/saved';
import { refFromKey, refKey } from '../src/core/slug';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const summary = (overrides: Partial<MarketSummary> = {}): MarketSummary => ({
  probability: 0.5,
  change24h: 0.01,
  change7d: 0.02,
  volume24h: 1000,
  liquidity: 50_000,
  signal: 'POSITIVE',
  strength: 40,
  at: NOW - 30 * MIN,
  ...overrides,
});

const on = (overrides: Partial<AlertSettings> = {}): AlertSettings => ({ ...DEFAULT_ALERT_SETTINGS, enabled: true, ...overrides });

const item = (key: string, overrides: Partial<WatchItem> = {}): WatchItem => ({
  key: `${key}/`,
  ref: { eventSlug: key, marketSlug: null },
  title: `Market ${key}`,
  outcome: 'Yes',
  addedAt: 1,
  last: summary(),
  previous: null,
  alerts: [],
  alertSettings: on(),
  ...overrides,
});

describe('plan seam', () => {
  it('early access gives everyone Pro; the stored plan decides afterwards', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
    expect(effectivePlan('free')).toBe('pro');
    expect(effectivePlan('free', false)).toBe('free');
    expect(effectivePlan('pro', false)).toBe('pro');
    for (const feature of PRO_FEATURES) expect(hasFeature(effectivePlan('free'), feature)).toBe(true);
  });

  it('free: basic analysis, 5-market watchlist, 24H/7D; Pro: alerts, unlimited watchlist, compare, 30D', () => {
    expect(PRO_FEATURES).toEqual(['alerts', 'unlimitedWatchlist', 'compare', 'chart30d']);
    for (const feature of PRO_FEATURES) {
      expect(hasFeature('free', feature)).toBe(false);
      expect(hasFeature('pro', feature)).toBe(true);
      expect(PRO_FEATURE_INFO[feature].title).toBeTruthy();
    }
    expect(limitsFor('free')).toEqual({ watchlist: 5, chartRanges: ['24h', '7d'] });
    expect(limitsFor('pro')).toEqual({ watchlist: Number.POSITIVE_INFINITY, chartRanges: ['24h', '7d', '30d'] });
    expect(HISTORY_LIMIT).toBe(100);
    expect(FREE_INCLUDES.join(' ')).toMatch(/analysis/);
  });

  it('sanitizes the stored plan and words the limit calmly', () => {
    expect(isPlan('pro')).toBe(true);
    expect(isPlan('enterprise')).toBe(false);
    expect(watchlistLimitMessage(5)).toBe('Free keeps 5 markets on the watchlist. Pro removes the limit.');
  });

  it('an unlimited plan never refuses; a free list above the limit is kept, only additions are refused', () => {
    const many = Array.from({ length: 30 }, (_, index) => item(`m${index}`));
    expect(addToWatchlist(many, item('new'), limitsFor('pro').watchlist)).toMatchObject({ ok: true });
    const result = addToWatchlist(many, item('new'), limitsFor('free').watchlist);
    expect(result).toMatchObject({ ok: false, reason: 'limit' });
    expect(result.items).toHaveLength(30);
  });
});

describe('alert settings', () => {
  it('defaults: off, 5 pp, +100 %, momentum flip', () => {
    expect(sanitizeAlertSettings(undefined)).toEqual({ enabled: false, movePp: 5, volumePct: 100, momentumFlip: true });
    expect(rulesFor(DEFAULT_ALERT_SETTINGS).map(({ kind }) => kind)).toEqual(DEFAULT_ALERT_RULES.map(({ kind }) => kind));
  });

  it('clamps and rounds thresholds, keeps null (rule off), repairs junk', () => {
    expect(sanitizeAlertSettings({ enabled: true, movePp: '2.26', volumePct: 55, momentumFlip: false })).toEqual({ enabled: true, movePp: 2.5, volumePct: 60, momentumFlip: false });
    expect(sanitizeAlertSettings({ movePp: 0, volumePct: 99_999 })).toMatchObject({ movePp: 0.5, volumePct: 1000 });
    expect(sanitizeAlertSettings({ movePp: null, volumePct: null })).toMatchObject({ movePp: null, volumePct: null });
    expect(sanitizeAlertSettings({ enabled: 'yes', movePp: 'abc', volumePct: Number.NaN, momentumFlip: 1 })).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(sanitizeAlertSettings([1, 2])).toEqual(DEFAULT_ALERT_SETTINGS);
  });

  it('rules, activity and description follow the settings', () => {
    const settings = on({ movePp: 3, volumePct: null, momentumFlip: true });
    expect(rulesFor(settings)).toEqual([
      { id: 'move-3pp', kind: 'probability-move', thresholdPp: 3 },
      { id: 'momentum-flip', kind: 'momentum-flip' },
    ]);
    expect(describeAlertSettings(settings)).toBe('Move > 3 pp · Momentum flip');
    expect(hasActiveAlerts(settings)).toBe(true);
    expect(hasActiveAlerts({ ...settings, enabled: false })).toBe(false);
    expect(hasActiveAlerts(on({ movePp: null, volumePct: null, momentumFlip: false }))).toBe(false);
    expect(describeAlertSettings(on({ movePp: null, volumePct: null, momentumFlip: false }))).toBe('No rules selected');
  });

  it('is stored with the watchlist item and sanitized on read', () => {
    const [stored] = sanitizeWatchlist([{ ...item('a'), alertSettings: { enabled: true, movePp: 500 } }], 10);
    expect(stored!.alertSettings).toEqual({ enabled: true, movePp: 50, volumePct: 100, momentumFlip: true });
    const [legacy] = sanitizeWatchlist([{ ref: { eventSlug: 'a', marketSlug: null }, title: 'Old item', addedAt: 1 }], 10);
    expect(legacy!.alertSettings).toEqual(DEFAULT_ALERT_SETTINGS);
  });

  it('the popup uses the market rules when set up, the defaults otherwise', () => {
    expect(inlineRules(item('a', { alertSettings: DEFAULT_ALERT_SETTINGS }))).toBe(DEFAULT_ALERT_RULES);
    expect(inlineRules(item('a', { alertSettings: on({ movePp: 2, volumePct: null, momentumFlip: false }) }))).toEqual([{ id: 'move-2pp', kind: 'probability-move', thresholdPp: 2 }]);
  });
});

describe('background check budget', () => {
  it('checks only markets with active alerts, not checked recently, oldest first, bounded', () => {
    const items = [
      item('recent', { last: summary({ at: NOW - 2 * MIN }) }),
      item('off', { alertSettings: { ...DEFAULT_ALERT_SETTINGS, enabled: false } }),
      item('no-rules', { alertSettings: on({ movePp: null, volumePct: null, momentumFlip: false }) }),
      item('old', { last: summary({ at: NOW - 60 * MIN }) }),
      item('never', { last: null }),
      item('middle', { last: summary({ at: NOW - MIN_RECHECK_MS }) }),
      item('future', { last: summary({ at: NOW + 60 * MIN }) }),
    ];
    expect(marketsToCheck(items, NOW).map((entry) => entry.ref.eventSlug)).toEqual(['never', 'old', 'middle', 'future']);
    const many = Array.from({ length: 25 }, (_, index) => item(`m${index}`, { last: summary({ at: NOW - (index + 11) * MIN }) }));
    const due = marketsToCheck(many, NOW);
    expect(due).toHaveLength(MAX_MARKETS_PER_CHECK);
    expect(due[0]!.ref.eventSlug).toBe('m24');
    expect(marketsToCheck(many, NOW, 0)).toEqual([]);
  });

  it('needs an alarm only while some market has active alerts', () => {
    expect(needsAlarm([item('a', { alertSettings: DEFAULT_ALERT_SETTINGS })])).toBe(false);
    expect(needsAlarm([item('a', { alertSettings: DEFAULT_ALERT_SETTINGS }), item('b')])).toBe(true);
    expect(needsAlarm([])).toBe(false);
  });

  it('backs off after a rate limit: at least 30 min, longer if asked', () => {
    expect(backoffAfterRateLimit(NOW)).toBe(NOW + RATE_LIMIT_BACKOFF_MS);
    expect(backoffAfterRateLimit(NOW, 30)).toBe(NOW + RATE_LIMIT_BACKOFF_MS);
    expect(backoffAfterRateLimit(NOW, 3600)).toBe(NOW + 3600_000);
    expect(backoffAfterRateLimit(NOW, 10 ** 9)).toBe(NOW + 24 * 3600_000);
    const state = sanitizeAlertCheckState({ backoffUntil: NOW + MIN });
    expect(isBackingOff(state, NOW)).toBe(true);
    expect(isBackingOff(state, NOW + 2 * MIN)).toBe(false);
  });

  it('sanitizes the stored run state', () => {
    expect(sanitizeAlertCheckState({ lastRunAt: 'x', checked: -1, notified: 2.4, failed: 1e9, lastError: '' })).toEqual({
      lastRunAt: null,
      checked: 0,
      notified: 2,
      failed: 1000,
      backoffUntil: null,
      lastError: null,
    });
  });
});

describe('applying a check', () => {
  it('compares with the previous check, records it and returns the alerts', () => {
    const before = item('a', { last: summary({ probability: 0.624, volume24h: 1000, signal: 'POSITIVE' }) });
    const { item: after, events } = applyCheck(before, summary({ probability: 0.7, volume24h: 2600, signal: 'NEGATIVE', at: NOW }));
    expect(events.map((event) => event.message)).toEqual([
      'Moved +7.6 pp since last check (62.4% → 70.0%)',
      '24h volume up 160% since last check',
      'Momentum flipped to negative momentum',
    ]);
    expect(after.previous).toBe(before.last);
    expect(after.last?.at).toBe(NOW);
    expect(after.alerts).toHaveLength(3);
  });

  it('respects the market thresholds and ignores older observations', () => {
    const before = item('a', { alertSettings: on({ movePp: 10, volumePct: null, momentumFlip: false }), last: summary({ probability: 0.5 }) });
    expect(applyCheck(before, summary({ probability: 0.58, at: NOW })).events).toEqual([]);
    expect(applyCheck(before, summary({ probability: 0.61, at: NOW })).events).toHaveLength(1);
    const stale = applyCheck(before, summary({ probability: 0.9, at: before.last!.at - 1 }));
    expect(stale.item).toBe(before);
    expect(stale.events).toEqual([]);
  });

  it('first check has nothing to compare with', () => {
    const { item: after, events } = applyCheck(item('a', { last: null }), summary({ at: NOW }));
    expect(events).toEqual([]);
    expect(after.last?.at).toBe(NOW);
  });
});

describe('notifications', () => {
  it('title is the market, message is the numbers; never tells anyone to buy or bet', () => {
    const watched = item('fed', { title: 'Will the Fed cut rates by 25 bps in December 2026?', outcome: '25 bps cut' });
    const { events } = applyCheck(watched, summary({ probability: 0.6, volume24h: 3000, signal: 'STRONG_NEGATIVE', at: NOW }));
    const content = alertNotification(watched, events);
    expect(content.title).toBe('Will the Fed cut rates by 25 bps in December 2026?');
    expect(content.message).toBe('Moved +10.0 pp since last check (50.0% → 60.0%)\n24h volume up 200% since last check\nMomentum flipped to strong negative momentum');
    expect(content.contextMessage).toBe('25 bps cut · Watchlist alert');
    for (const text of Object.values(content)) expect(text).not.toMatch(FORBIDDEN_NOTIFICATION_WORDS);
    expect(alertNotification(item('x', { title: 'A'.repeat(200) }), events).title).toHaveLength(90);
  });

  it('the forbidden-word check catches advice words but not ordinary ones', () => {
    for (const text of ['Buy now', 'place a bet', 'Betting odds', 'guaranteed profit']) expect(text).toMatch(FORBIDDEN_NOTIFICATION_WORDS);
    for (const text of ['between 2 and 3', 'better than', 'Alphabet shares']) expect(text).not.toMatch(FORBIDDEN_NOTIFICATION_WORDS);
  });

  it('notification ids carry the watchlist key', () => {
    const key = refKey({ eventSlug: 'fed-decision', marketSlug: 'fed-cut-25' });
    const id = notificationId(key, NOW);
    expect(keyFromNotificationId(id)).toBe(key);
    expect(keyFromNotificationId('something-else')).toBeNull();
    expect(keyFromNotificationId('pm-alert|')).toBeNull();
    expect(refFromKey(key)).toEqual({ eventSlug: 'fed-decision', marketSlug: 'fed-cut-25' });
    expect(refFromKey('/only-market')).toEqual({ eventSlug: null, marketSlug: 'only-market' });
    expect(refFromKey('../etc/')).toBeNull();
    expect(refFromKey('no-slash')).toBeNull();
  });
});
