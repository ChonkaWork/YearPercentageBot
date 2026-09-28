import { describe, expect, it } from 'vitest';
import { DEFAULT_LIFE, MAX_LIFE_YEARS, MIN_LIFE_YEARS, describeLife, sanitizeLife, validateLifeDraft } from '../src/core/life';

const NOW = new Date(2026, 9, 16, 9, 41);

describe('sanitizeLife', () => {
  it('defaults to no birth date and 80 years', () => {
    expect(DEFAULT_LIFE).toEqual({ birthDate: null, years: 80 });
    for (const raw of [undefined, null, 'x', 42, [], {}]) expect(sanitizeLife(raw)).toEqual(DEFAULT_LIFE);
  });

  it('keeps valid values and drops invalid ones field by field', () => {
    expect(sanitizeLife({ birthDate: '1990-05-01', years: 90 })).toEqual({ birthDate: '1990-05-01', years: 90 });
    expect(sanitizeLife({ birthDate: '1899-12-31', years: 90 })).toEqual({ birthDate: null, years: 90 });
    expect(sanitizeLife({ birthDate: '1990-02-29', years: 19 })).toEqual({ birthDate: null, years: 80 });
    expect(sanitizeLife({ birthDate: '2000-02-29', years: 121 })).toEqual({ birthDate: '2000-02-29', years: 80 });
    expect(sanitizeLife({ birthDate: 19900501, years: '90' })).toEqual({ birthDate: null, years: 80 });
    expect(sanitizeLife({ birthDate: '1990-05-01', years: MIN_LIFE_YEARS }).years).toBe(MIN_LIFE_YEARS);
    expect(sanitizeLife({ birthDate: '1990-05-01', years: MAX_LIFE_YEARS }).years).toBe(MAX_LIFE_YEARS);
  });
});

describe('validateLifeDraft', () => {
  it('accepts a birth date and a span (empty span means 80)', () => {
    expect(validateLifeDraft({ birthDate: '1990-05-01', years: '85' }, NOW)).toEqual({ ok: true, value: { birthDate: '1990-05-01', years: 85 } });
    expect(validateLifeDraft({ birthDate: ' 1990-05-01 ', years: '' }, NOW)).toEqual({ ok: true, value: { birthDate: '1990-05-01', years: 80 } });
    expect(validateLifeDraft({ birthDate: '2026-10-16', years: '80' }, NOW).ok).toBe(true);
  });

  it('explains what is wrong', () => {
    const errors = (birthDate: string, years = '80', birthDateIncomplete = false) => {
      const result = validateLifeDraft({ birthDate, years, birthDateIncomplete }, NOW);
      return result.ok ? {} : result.errors;
    };
    expect(errors('')).toEqual({ birthDate: 'Enter your birth date.' });
    expect(errors('', '80', true)).toEqual({ birthDate: 'Enter a complete date.' });
    expect(errors('1990-02-30')).toEqual({ birthDate: 'Enter a real date from 1900 on.' });
    expect(errors('1850-01-01')).toEqual({ birthDate: 'Enter a real date from 1900 on.' });
    expect(errors('2026-10-17')).toEqual({ birthDate: 'That date is in the future.' });
    expect(errors('1990-05-01', '19')).toEqual({ years: 'Use a whole number from 20 to 120.' });
    expect(errors('1990-05-01', '80.5')).toEqual({ years: 'Use a whole number from 20 to 120.' });
    expect(errors('1990-05-01', 'abc')).toEqual({ years: 'Use a whole number from 20 to 120.' });
    expect(errors('', '500')).toEqual({ birthDate: 'Enter your birth date.', years: 'Use a whole number from 20 to 120.' });
  });
});

describe('describeLife basics', () => {
  it('is null without a birth date', () => {
    expect(describeLife(DEFAULT_LIFE, NOW, 2)).toBeNull();
  });

  it('writes a readable summary', () => {
    const view = describeLife({ birthDate: '1990-05-01', years: 80 }, NOW, 2)!;
    expect(view.caption).toBe('Age 36 · week 25 of 52');
    expect(view.summary).toBe('1,902 weeks lived, about 2,272 left of 80 years (45.57%).');
  });
});
