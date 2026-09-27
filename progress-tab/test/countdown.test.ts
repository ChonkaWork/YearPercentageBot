import { describe, expect, it } from 'vitest';
import {
  MAX_COUNTDOWNS,
  MAX_NAME_LENGTH,
  CountdownLimitError,
  addCountdown,
  createCountdown,
  normalizeName,
  parseDate,
  parseTime,
  removeCountdown,
  sanitizeCountdowns,
  updateCountdown,
  validateDraft,
  type Countdown,
} from '../src/core/countdown';

const NOW = 1_790_000_000_000;

function countdown(overrides: Partial<Countdown> = {}): Countdown {
  return { id: 'a', name: 'Trip', date: '2026-12-24', time: null, createdAt: NOW, showProgress: true, ...overrides };
}

describe('parseDate', () => {
  it('accepts real calendar dates only', () => {
    expect(parseDate('2026-12-24')).toEqual({ year: 2026, month: 12, day: 24 });
    expect(parseDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDate(' 2026-01-01 ')).toEqual({ year: 2026, month: 1, day: 1 });
    for (const bad of ['2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-9-1', '0999-01-01', '10000-01-01', '', 'soon', 20261224, null]) {
      expect(parseDate(bad), String(bad)).toBeNull();
    }
  });
});

describe('parseTime', () => {
  it('accepts HH:MM (and ignores seconds)', () => {
    expect(parseTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('07:45:30')).toEqual({ hour: 7, minute: 45 });
    expect(parseTime('07:45:30.123')).toEqual({ hour: 7, minute: 45 });
    for (const bad of ['24:00', '12:60', '7:45', '0745', '', 'noon', 745, undefined]) expect(parseTime(bad), String(bad)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('trims, collapses whitespace and drops control characters', () => {
    expect(normalizeName('  New \t Year\n ')).toBe('New Year');
    expect(normalizeName('a\u0000b​c d')).toBe('a b c d');
    expect(normalizeName('Відпустка 🏖️')).toBe('Відпустка 🏖️');
  });
});

describe('validateDraft', () => {
  const draft = { name: 'Trip', date: '2026-12-24', time: '', showProgress: true };

  it('returns clean fields', () => {
    expect(validateDraft({ ...draft, name: '  Trip  ', time: '07:45:00' })).toEqual({
      ok: true,
      value: { name: 'Trip', date: '2026-12-24', time: '07:45', showProgress: true },
    });
    expect(validateDraft(draft)).toEqual({ ok: true, value: { name: 'Trip', date: '2026-12-24', time: null, showProgress: true } });
  });

  it('explains every problem at once', () => {
    expect(validateDraft({ name: ' ', date: '', time: '', showProgress: true })).toEqual({
      ok: false,
      errors: { name: 'Give the countdown a name.', date: 'Pick a date.' },
    });
    expect(validateDraft({ ...draft, date: '2026-02-30', time: '25:00' })).toEqual({
      ok: false,
      errors: { date: 'Enter a real date between the years 1000 and 9999.', time: 'Enter a valid time, or leave it empty.' },
    });
    expect(validateDraft({ ...draft, name: 'x'.repeat(MAX_NAME_LENGTH + 1) })).toMatchObject({ ok: false, errors: { name: expect.stringContaining('80') } });
  });

  it('reports half-typed date and time fields', () => {
    expect(validateDraft({ ...draft, date: '', dateIncomplete: true, timeIncomplete: true })).toEqual({
      ok: false,
      errors: { date: 'Enter a complete date.', time: 'Enter a complete time, or clear it.' },
    });
  });
});

describe('list operations', () => {
  it('creates, adds, updates and removes', () => {
    const created = createCountdown({ name: 'Trip', date: '2026-12-24', time: '09:00', showProgress: false }, 'id-1', NOW);
    expect(created).toEqual({ id: 'id-1', name: 'Trip', date: '2026-12-24', time: '09:00', showProgress: false, createdAt: NOW });
    const list = addCountdown([countdown()], created);
    expect(list.map((c) => c.id)).toEqual(['a', 'id-1']);
    // Adding the same id again (e.g. a double undo) changes nothing.
    expect(addCountdown(list, created)).toEqual(list);
    const updated = updateCountdown(list, 'id-1', { name: 'Trip!', date: '2027-01-02', time: null, showProgress: true });
    expect(updated[1]).toEqual({ id: 'id-1', name: 'Trip!', date: '2027-01-02', time: null, showProgress: true, createdAt: NOW });
    expect(removeCountdown(updated, 'a').map((c) => c.id)).toEqual(['id-1']);
    expect(removeCountdown(updated, 'missing')).toEqual(updated);
  });

  it('refuses more than the limit', () => {
    const full = Array.from({ length: MAX_COUNTDOWNS }, (_, i) => countdown({ id: `c${i}` }));
    expect(() => addCountdown(full, countdown({ id: 'one-more' }))).toThrow(CountdownLimitError);
  });
});

describe('sanitizeCountdowns', () => {
  it('returns [] for anything that is not a list', () => {
    for (const raw of [undefined, null, {}, 'x', 42]) expect(sanitizeCountdowns(raw, NOW)).toEqual([]);
  });

  it('keeps valid entries, drops broken ones and duplicates', () => {
    const result = sanitizeCountdowns(
      [
        countdown({ id: 'ok', name: '  Spaced   name ' }),
        { ...countdown({ id: 'no-created' }), createdAt: 'yesterday' },
        { ...countdown({ id: 'no-flag' }), showProgress: undefined },
        countdown({ id: 'ok', name: 'Duplicate' }),
        countdown({ id: 'bad-date', date: '2026-02-30' }),
        countdown({ id: 'bad-time', time: '99:00' }),
        countdown({ id: 'empty-name', name: '   ' }),
        countdown({ id: '', name: 'No id' }),
        { ...countdown({ id: 'seconds' }), time: '18:30:00' },
        { ...countdown({ id: 'empty-time' }), time: '' },
        null,
        'nonsense',
      ],
      NOW,
    );
    expect(result.map((c) => c.id)).toEqual(['ok', 'no-created', 'no-flag', 'seconds', 'empty-time']);
    expect(result[0]?.name).toBe('Spaced name');
    expect(result[1]?.createdAt).toBe(NOW);
    expect(result[2]?.showProgress).toBe(true);
    expect(result[3]?.time).toBe('18:30');
    expect(result[4]?.time).toBeNull();
  });

  it('caps the list and long names (without splitting emoji)', () => {
    const many = Array.from({ length: MAX_COUNTDOWNS + 5 }, (_, i) => countdown({ id: `c${i}` }));
    expect(sanitizeCountdowns(many, NOW)).toHaveLength(MAX_COUNTDOWNS);
    const long = sanitizeCountdowns([countdown({ name: `${'a'.repeat(MAX_NAME_LENGTH - 1)}🎉🎉` })], NOW)[0]?.name ?? '';
    expect(long.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(long.endsWith('a')).toBe(true);
  });
});
