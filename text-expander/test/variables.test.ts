import { describe, expect, it } from 'vitest';
import { expandTemplate, formatDate, hasVariables, renderForCopy } from '../src/core/variables';

// Local time components, so results don't depend on the machine's time zone.
const now = new Date(2026, 8, 7, 15, 4, 9); // Monday, September 7, 2026, 15:04:09
const morning = new Date(2026, 0, 2, 0, 5, 0);
const expand = (template: string, singleLine = false) => expandTemplate(template, { now, locale: 'en-US', singleLine });

describe('expandTemplate', () => {
  it('leaves plain text alone', () => {
    expect(expand('Best regards,\nAlex')).toEqual({ text: 'Best regards,\nAlex', cursor: null });
  });

  it('fills in default date and time formats for the locale', () => {
    expect(expand('{date}').text).toBe('9/7/2026');
    expect(expand('{time}').text).toBe('3:04 PM');
    expect(expand('{datetime}').text).toBe('9/7/2026, 3:04 PM');
    expect(expand('{weekday}').text).toBe('Monday');
    expect(expandTemplate('{date}', { now, locale: 'de-DE' }).text).toBe('7.9.2026');
    expect(expandTemplate('{time}', { now, locale: 'de-DE' }).text).toBe('15:04');
  });

  it('supports custom formats', () => {
    expect(expand('{date:YYYY-MM-DD}').text).toBe('2026-09-07');
    expect(expand('{date:D MMMM YYYY}').text).toBe('7 September 2026');
    expect(expand('{time:HH:mm:ss}').text).toBe('15:04:09');
    expect(expand('{datetime:ddd, MMM D [at] h:mm a}').text).toBe('Mon, Sep 7 at 3:04 pm');
  });

  it('is case-insensitive for names and keeps unknown placeholders', () => {
    expect(expand('{DATE:YY}').text).toBe('26');
    expect(expand('Hello {name}, {{date}} {weekday:x} {cursor:1}').text).toBe('Hello {name}, {9/7/2026} {weekday:x} {cursor:1}');
    expect(expand('function f() { return {}; }').text).toBe('function f() { return {}; }');
  });

  it('places the cursor at the first {cursor} and drops the others', () => {
    expect(expand('Hi {cursor},\nthanks{cursor}!')).toEqual({ text: 'Hi ,\nthanks!', cursor: 3 });
    expect(expand('{cursor}{date:YYYY}')).toEqual({ text: '2026', cursor: 0 });
    expect(expand('{date:YYYY} {Cursor}')).toEqual({ text: '2026 ', cursor: 5 });
  });

  it('flattens line breaks for single-line inputs and keeps the cursor right', () => {
    expect(expand('Best regards,\n\n  Alex', true)).toEqual({ text: 'Best regards, Alex', cursor: null });
    expect(expand('Line one\n{cursor}Line two', true)).toEqual({ text: 'Line one Line two', cursor: 9 });
  });

  it('never lets a NUL in the template act as the cursor', () => {
    expect(expand('a\u0000b')).toEqual({ text: 'ab', cursor: null });
  });

  it('copies without the cursor marker', () => {
    expect(renderForCopy('Hi {cursor}! {date:YYYY}', now, 'en-US')).toBe('Hi ! 2026');
  });

  it('falls back to the default locale for a broken locale tag', () => {
    expect(() => expandTemplate('{date}', { now, locale: 'not a locale!!' })).not.toThrow();
  });

  it('detects variables', () => {
    expect(hasVariables('Hi {date}')).toBe(true);
    expect(hasVariables('Hi {name}')).toBe(false);
    expect(hasVariables('Hi {date}')).toBe(true);
  });
});

describe('formatDate', () => {
  it('formats 12- and 24-hour clocks around midnight', () => {
    expect(formatDate(morning, 'H:mm h:mm A hh')).toBe('0:05 12:05 AM 12');
    expect(formatDate(now, 'HH hh h A')).toBe('15 03 3 PM');
  });

  it('keeps bracketed text and unknown letters', () => {
    expect(formatDate(now, '[YYYY] YYYY [Q]Q')).toBe('YYYY 2026 QQ');
  });

  it('uses the right grammatical case for month names next to a day', () => {
    expect(formatDate(now, 'D MMMM', 'ru-RU')).toBe('7 сентября');
    expect(formatDate(now, 'MMMM', 'ru-RU')).toBe('сентябрь');
    expect(formatDate(now, 'dddd', 'uk-UA')).toBe('понеділок');
  });

  it('pads years and short forms', () => {
    expect(formatDate(new Date(987, 0, 1), 'YYYY YY M/D')).toBe('0987 87 1/1');
  });
});
