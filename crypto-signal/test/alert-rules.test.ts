import { describe, expect, it } from 'vitest';
import {
  ALERT_CHOICE_TEXT,
  ALERT_CHOICES,
  ALERT_CONTEXT,
  conditionFromChoice,
  createAlertRule,
  defaultLevel,
  describeCondition,
  evaluateAlert,
  notificationFor,
  notificationId,
  parseNotificationId,
  roundPrice,
  sanitizeAlertRules,
  sanitizeAlertSnapshot,
  type AlertRule,
  type AlertSnapshot,
} from '../src/core/alerts';
import { SIGNAL_LABELS } from '../src/core/signal';

const input = { symbol: 'BTC', interval: '4h' as const, choice: 'turns-bearish' as const, level: null };

describe('alert rules from the popup form', () => {
  it('maps every choice to a condition with a matching description', () => {
    for (const choice of ALERT_CHOICES) {
      const level = choice.startsWith('rsi') ? 70 : choice.startsWith('price') ? 60000 : null;
      const text = describeCondition(conditionFromChoice(choice, level));
      expect(text.startsWith(ALERT_CHOICE_TEXT[choice])).toBe(true);
    }
    expect(conditionFromChoice('turns-bearish', null)).toEqual({ type: 'signal-becomes', signals: ['BEARISH', 'STRONG_BEARISH'] });
    expect(describeCondition({ type: 'signal-becomes', signals: ['STRONG_BEARISH', 'BEARISH'] })).toBe('Signal turns bearish');
    expect(describeCondition({ type: 'signal-becomes', signals: ['NEUTRAL', 'BULLISH'] })).toBe('Signal becomes Neutral or Bullish');
    expect(describeCondition(conditionFromChoice('price-below', 60000))).toBe('Price crosses below 60,000.00');
    expect(describeCondition({ type: 'rsi-crosses', level: 72.5, direction: 'above' })).toBe('RSI crosses above 72.5');
    expect(describeCondition({ type: 'strength-at-least', strength: 60 })).toBe('Signal strength reaches 60%');
  });

  it('suggests levels', () => {
    expect(defaultLevel('rsi-above', null)).toBe(70);
    expect(defaultLevel('rsi-below', 100)).toBe(30);
    expect(defaultLevel('price-below', 64231.5)).toBe(61000);
    expect(defaultLevel('price-above', 0.4512)).toBe(0.474);
    expect(defaultLevel('price-above', null)).toBeNull();
    expect(defaultLevel('signal-changed', 100)).toBeNull();
    expect(roundPrice(Number.NaN)).toBe(0);
  });

  it('validates input, limits and duplicates, never removing existing alerts', () => {
    const first = createAlertRule(input, [], 10, 'a', 1000);
    expect(first).toEqual({ ok: true, rule: { id: 'a', symbol: 'BTC', interval: '4h', condition: conditionFromChoice('turns-bearish', null), enabled: true, createdAt: 1000 } });
    if (!first.ok) throw new Error();
    expect(createAlertRule(input, [first.rule], 10, 'b', 1000)).toEqual({ ok: false, error: 'You already have this alert.' });
    expect(createAlertRule(input, [first.rule], 1, 'b', 1000)).toEqual({ ok: false, error: 'You have 1 of 1 alerts. Delete one to add another.' });
    expect(createAlertRule(input, [], 0, 'b', 1000)).toEqual({ ok: false, error: 'Background alerts are part of Pro.' });
    expect(createAlertRule({ ...input, choice: 'rsi-above', level: 100 }, [], 10, 'b', 1).ok).toBe(false);
    expect(createAlertRule({ ...input, choice: 'rsi-above', level: Number.NaN }, [], 10, 'b', 1).ok).toBe(false);
    expect(createAlertRule({ ...input, choice: 'price-below', level: -5 }, [], 10, 'b', 1)).toEqual({ ok: false, error: 'Enter a price above 0.' });
    expect(createAlertRule({ ...input, symbol: 'bad symbol' }, [], 10, 'b', 1).ok).toBe(false);
    expect(createAlertRule({ ...input, choice: 'rsi-above', level: 70 }, [first.rule], 10, 'b', 1).ok).toBe(true);
  });
});

describe('alert storage', () => {
  const rule: AlertRule = { id: 'a', symbol: 'BTC', interval: '4h', condition: { type: 'rsi-crosses', level: 70, direction: 'above' }, enabled: true, createdAt: 5, since: 9 };

  it('keeps valid rules and drops broken or duplicate ones', () => {
    const raw = [
      rule,
      rule,
      { ...rule, id: 'b', condition: { type: 'rsi-crosses', level: 170, direction: 'above' } },
      { ...rule, id: 'c', condition: { type: 'price-crosses', price: 0, direction: 'below' } },
      { ...rule, id: 'd', condition: { type: 'signal-becomes', signals: ['NOPE'] } },
      { ...rule, id: 'e', condition: { type: 'signal-becomes', signals: ['BEARISH', 'NOPE'] }, since: 1 },
      { ...rule, id: 'f', interval: '5m' },
      { ...rule, id: 'g', enabled: 'yes' },
      { ...rule, id: 'h', condition: { type: 'teleport' } },
      null,
      'x',
    ];
    expect(sanitizeAlertRules(raw)).toEqual([rule, { ...rule, id: 'e', condition: { type: 'signal-becomes', signals: ['BEARISH'] }, since: undefined }].map(({ since, ...r }) => (since === undefined ? r : { ...r, since })));
    expect(sanitizeAlertRules('nope')).toEqual([]);
    expect(sanitizeAlertRules(Array.from({ length: 80 }, (_, i) => ({ ...rule, id: `r${i}` })))).toHaveLength(50);
  });

  it('validates snapshots', () => {
    const snapshot: AlertSnapshot = { symbol: 'BTC', interval: '4h', signal: 'BULLISH', strength: 38, price: 1, rsi: 55, at: 1 };
    expect(sanitizeAlertSnapshot(snapshot)).toEqual(snapshot);
    expect(sanitizeAlertSnapshot({ ...snapshot, rsi: 101 })).toBeNull();
    expect(sanitizeAlertSnapshot({ ...snapshot, price: 0 })).toBeNull();
    expect(sanitizeAlertSnapshot({ ...snapshot, signal: 'BUY' })).toBeNull();
  });
});

describe('notifications', () => {
  const base: AlertSnapshot = { symbol: 'BTC', interval: '4h', signal: 'STRONG_BULLISH', strength: 75, price: 64231.5, rsi: 60.7, at: 1000 };
  const after: AlertSnapshot = { ...base, signal: 'BEARISH', strength: 50, price: 3120.55, rsi: 32.8, at: 2000 };

  it('round-trips the market through the notification id', () => {
    const event = { ruleId: 'r-1', symbol: 'BTC', interval: '4h' as const, message: 'x', at: 2000 };
    expect(parseNotificationId(notificationId(event))).toEqual({ symbol: 'BTC', interval: '4h', ruleId: 'r-1' });
    expect(parseNotificationId('other|BTC|4h|r')).toBeNull();
    expect(parseNotificationId('cs-alert|btc|4h|r')).toBeNull();
    expect(parseNotificationId('cs-alert|BTC|5m|r')).toBeNull();
  });

  it('describes indicator events only: never buy, sell or a prediction', () => {
    const forbidden = /\b(buy|sell|long|short|profit|guarantee|will (rise|fall|go))/i;
    for (const text of Object.values(ALERT_CHOICE_TEXT)) expect(text).not.toMatch(forbidden);
    const conditions = [
      ...ALERT_CHOICES.map((choice) => conditionFromChoice(choice, choice.startsWith('rsi') ? (choice === 'rsi-above' ? 50 : 40) : choice.startsWith('price') ? (choice === 'price-above' ? 4000 : 60000) : null)),
      ...SIGNAL_LABELS.map((label) => ({ type: 'signal-becomes' as const, signals: [label] })),
    ];
    let fired = 0;
    for (const [i, condition] of conditions.entries()) {
      const rule: AlertRule = { id: `r${i}`, symbol: 'BTC', interval: '4h', condition, enabled: true, createdAt: 0 };
      for (const [previous, current] of [[base, after], [after, { ...base, at: 3000 }]] as const) {
        const event = evaluateAlert(rule, previous, current);
        if (!event) continue;
        fired++;
        const content = notificationFor(rule, event, 'USDT');
        expect(content.title).toMatch(/^BTC\/USDT 4h · /);
        expect(`${content.title} ${content.message}`).not.toMatch(forbidden);
        expect(content.contextMessage).toBe(ALERT_CONTEXT);
        expect(ALERT_CONTEXT).toMatch(/not financial advice/);
      }
    }
    expect(fired).toBeGreaterThanOrEqual(10);
  });
});
