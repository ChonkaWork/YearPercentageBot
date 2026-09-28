import { describe, expect, it } from 'vitest';
import { previewParts, previewPlainText } from '../src/core/preview';

const now = new Date(2026, 8, 7, 15, 4, 9);
const parts = (template: string, extra: { fields?: boolean; oneLine?: boolean; max?: number } = {}) =>
  previewParts(template, { now, locale: 'en-US', fields: extra.fields ?? true, oneLine: extra.oneLine, max: extra.max });

describe('previewParts', () => {
  it('shows {cursor} as a caret instead of an orphan space', () => {
    expect(parts('Hi {cursor},\n\nWould you have 30 minutes?', { oneLine: true })).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'caret' },
      { kind: 'text', text: ', ⏎ Would you have 30 minutes?' },
    ]);
    // Only the first {cursor} counts, like when expanding.
    expect(parts('{cursor}a{cursor}b')).toEqual([{ kind: 'caret' }, { kind: 'text', text: 'ab' }]);
  });

  it('shows dates and times as filled-in chips', () => {
    expect(parts('Due {date:YYYY-MM-DD} ({weekday})')).toEqual([
      { kind: 'text', text: 'Due ' },
      { kind: 'value', text: '2026-09-07', token: '{date:YYYY-MM-DD}' },
      { kind: 'text', text: ' (' },
      { kind: 'value', text: 'Monday', token: '{weekday}' },
      { kind: 'text', text: ')' },
    ]);
    expect(parts('{time}')[0]).toEqual({ kind: 'value', text: '3:04 PM', token: '{time}' });
  });

  it('shows fill-in fields, choices and the clipboard as placeholders', () => {
    expect(parts('Hi {input:Name=Sam}, {choice:Day=Mon|Tue} {clipboard}')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'field', text: 'Name', token: '{input:Name=Sam}' },
      { kind: 'text', text: ', ' },
      { kind: 'field', text: 'Day ▾', token: '{choice:Day=Mon|Tue}' },
      { kind: 'text', text: ' ' },
      { kind: 'field', text: 'clipboard', token: '{clipboard}' },
    ]);
  });

  it('on the free plan shows fill-in fields as written, like they are inserted', () => {
    expect(parts('Hi {input:Name}! {choice:Day=Mon}', { fields: false })).toEqual([{ kind: 'text', text: 'Hi {input:Name}! {choice:Day=Mon}' }]);
  });

  it('keeps unknown and malformed variables as text', () => {
    expect(parts('{name} {cursor:1} {weekday:x} {clipboard:x} {choice:NoOptions} {input:}')).toEqual([
      { kind: 'text', text: '{name} {cursor:1} {weekday:x} {clipboard:x} {choice:NoOptions} {input:}' },
    ]);
  });

  it('collapses blank lines for two-line list previews', () => {
    expect(parts('Best,\n\n\nAlex')).toEqual([{ kind: 'text', text: 'Best,\nAlex' }]);
  });

  it('cuts one-line previews at the limit', () => {
    expect(parts('x'.repeat(50), { oneLine: true, max: 10 })).toEqual([{ kind: 'text', text: `${'x'.repeat(9)}…` }]);
    expect(parts('Today {date:YYYY-MM-DD} and more text', { oneLine: true, max: 12 })).toEqual([
      { kind: 'text', text: 'Today ' },
      { kind: 'text', text: '…' },
    ]);
    expect(parts('  padded\n', { oneLine: true })).toEqual([{ kind: 'text', text: 'padded' }]);
  });

  it('turns into plain text', () => {
    expect(previewPlainText(parts('Hi {cursor}{input:Name}, {date:YYYY}', { oneLine: true }))).toBe('Hi Name, 2026');
  });
});
