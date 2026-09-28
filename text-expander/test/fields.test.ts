import { describe, expect, it } from 'vitest';
import {
  defaultInputs,
  expandTemplate,
  hasFields,
  hasVariables,
  isChoice,
  MAX_CHOICE_OPTIONS,
  MAX_CLIPBOARD,
  normalizeClipboard,
  normalizeInputValue,
  parseChoiceSpec,
  parseFields,
  parseFieldSpec,
  renderForCopy,
  tokenize,
  usesClipboard,
  type FillField,
} from '../src/core/variables';

const now = new Date(2026, 8, 7, 15, 4, 9);

describe('fill-in fields', () => {
  it('parses {input:Name} and {input:Name=default}', () => {
    expect(parseFieldSpec('Name')).toEqual({ name: 'Name', defaultValue: '' });
    expect(parseFieldSpec(' Company = Acme Inc. ')).toEqual({ name: 'Company', defaultValue: ' Acme Inc. ' });
    expect(parseFieldSpec('Due=2026-10-01=late')).toEqual({ name: 'Due', defaultValue: '2026-10-01=late' });
    expect(parseFieldSpec('  ')).toBe(null);
    expect(parseFieldSpec('=x')).toBe(null);
    expect(parseFieldSpec('x'.repeat(41))).toBe(null);
  });

  it('lists distinct fields in order; a repeated name is asked once, first default wins', () => {
    const template = 'Hi {input:Name},\n{INPUT:Company=Acme} and {input:Name=Bob} again. {input} {input:} {date}';
    expect(parseFields(template)).toEqual([
      { name: 'Name', defaultValue: 'Bob' },
      { name: 'Company', defaultValue: 'Acme' },
    ]);
    expect(hasFields(template)).toBe(true);
    expect(hasFields('Plain {date} {cursor}')).toBe(false);
    expect(hasVariables('{input:Name}')).toBe(true);
    expect(defaultInputs(parseFields(template))).toEqual({ Name: 'Bob', Company: 'Acme' });
  });

  it('caps the number of fields', () => {
    const template = Array.from({ length: 20 }, (_, i) => `{input:F${i}}`).join(' ');
    expect(parseFields(template)).toHaveLength(12);
  });

  it('without values (free plan) leaves the fields exactly as written', () => {
    const template = 'Hi {input:Name=you}, today is {date:YYYY-MM-DD}';
    expect(expandTemplate(template, { now, locale: 'en-US' }).text).toBe('Hi {input:Name=you}, today is 2026-09-07');
    expect(renderForCopy(template, now, 'en-US')).toBe('Hi {input:Name=you}, today is 2026-09-07');
  });

  it('fills every occurrence; missing values fall back to the default', () => {
    const template = '{input:Name}, {input:Name}! {input:Team=Support}';
    expect(expandTemplate(template, { now, inputs: { Name: 'Ann' } }).text).toBe('Ann, Ann! Support');
    expect(expandTemplate(template, { now, inputs: { Name: 'Ann', Team: 'Sales' } }).text).toBe('Ann, Ann! Sales');
    expect(renderForCopy(template, now, 'en-US', {})).toBe(', ! Support');
  });

  it('treats typed values as plain text: never variables, never the caret', () => {
    const result = expandTemplate('Hi {input:Name}{cursor}!', { now, inputs: { Name: '{date} {cursor}\u0000' } });
    expect(result).toEqual({ text: 'Hi {date} {cursor}!', cursor: 'Hi {date} {cursor}'.length });
  });

  it('keeps {cursor} working next to fields and single-line inputs', () => {
    const result = expandTemplate('Dear {input:Name},{cursor}\nBest', { now, inputs: { Name: 'Kim' }, singleLine: true });
    expect(result).toEqual({ text: 'Dear Kim, Best', cursor: 'Dear Kim,'.length });
  });

  it('normalizes typed values', () => {
    expect(normalizeInputValue('a\r\nb\nc\u0007')).toBe('a b c');
  });
});

describe('choice fields', () => {
  it('parses {choice:Name=A|B|C}: trimmed, deduplicated options, the first is the default', () => {
    expect(parseChoiceSpec('Day=Monday|Tuesday|Wednesday')).toEqual({ name: 'Day', defaultValue: 'Monday', options: ['Monday', 'Tuesday', 'Wednesday'] });
    expect(parseChoiceSpec(' Plan = Pro | Free || Pro ')).toEqual({ name: 'Plan', defaultValue: 'Pro', options: ['Pro', 'Free'] });
    expect(parseChoiceSpec('Op=a=b|c')).toEqual({ name: 'Op', defaultValue: 'a=b', options: ['a=b', 'c'] });
    expect(parseChoiceSpec('Only=One')).toEqual({ name: 'Only', defaultValue: 'One', options: ['One'] });
    expect(parseChoiceSpec('NoOptions')).toBe(null);
    expect(parseChoiceSpec('Empty=| |')).toBe(null);
    expect(parseChoiceSpec('=A|B')).toBe(null);
    expect(parseChoiceSpec(`${'x'.repeat(41)}=A`)).toBe(null);
    expect(parseChoiceSpec(`Many=${Array.from({ length: 30 }, (_, i) => `o${i}`).join('|')}`)?.options).toHaveLength(MAX_CHOICE_OPTIONS);
  });

  it('lists choices with the other fields, in order; the first use of a name decides its kind', () => {
    const template = 'Hi {input:Name}, {choice:Day=Mon|Tue} or {CHOICE:Day=Fri}? {choice:Name=A|B}';
    const fields = parseFields(template);
    expect(fields).toEqual([
      { name: 'Name', defaultValue: '' },
      { name: 'Day', defaultValue: 'Mon', options: ['Mon', 'Tue'] },
    ]);
    expect(isChoice(fields[1] as FillField)).toBe(true);
    expect(isChoice(fields[0] as FillField)).toBe(false);
    expect(hasFields('{choice:Day=Mon}')).toBe(true);
    expect(hasFields('{choice:Day}')).toBe(false);
  });

  it('fills the picked option, the first one by default, and stays as written on Free', () => {
    const template = 'See you {choice:Day=Monday|Tuesday}!';
    expect(expandTemplate(template, { now, inputs: { Day: 'Tuesday' } }).text).toBe('See you Tuesday!');
    expect(expandTemplate(template, { now, inputs: {} }).text).toBe('See you Monday!');
    expect(expandTemplate(template, { now }).text).toBe('See you {choice:Day=Monday|Tuesday}!');
    expect(expandTemplate('{choice:Day}', { now, inputs: {} }).text).toBe('{choice:Day}');
  });
});

describe('{clipboard}', () => {
  it('inserts the clipboard text as plain text, nothing without it', () => {
    expect(expandTemplate('Link: {clipboard}!', { now, clipboard: 'https://example.com' }).text).toBe('Link: https://example.com!');
    expect(expandTemplate('Link: {clipboard}!', { now }).text).toBe('Link: !');
    expect(expandTemplate('{Clipboard}', { now, clipboard: 'x' }).text).toBe('x');
    expect(expandTemplate('{clipboard:x}', { now, clipboard: 'y' }).text).toBe('{clipboard:x}');
    expect(renderForCopy('> {clipboard}', now, 'en-US', undefined, 'quote')).toBe('> quote');
  });

  it('never treats clipboard text as variables or the caret, and normalizes line breaks', () => {
    expect(expandTemplate('[{clipboard}]{cursor}', { now, clipboard: '{date} {cursor}\u0000' })).toEqual({ text: '[{date} {cursor}]', cursor: '[{date} {cursor}]'.length });
    expect(expandTemplate('{clipboard}', { now, clipboard: 'a\r\nb\rc\u0007' }).text).toBe('a\nb\nc');
    expect(expandTemplate('{clipboard}', { now, clipboard: 'a\nb', singleLine: true }).text).toBe('a b');
    expect(normalizeClipboard('x'.repeat(MAX_CLIPBOARD + 10))).toHaveLength(MAX_CLIPBOARD);
  });

  it('is detected so the clipboard is read only when needed', () => {
    expect(usesClipboard('Link: {clipboard}')).toBe(true);
    expect(usesClipboard('{CLIPBOARD}')).toBe(true);
    expect(usesClipboard('{clipboard:x} {date}')).toBe(false);
    expect(hasVariables('{clipboard}')).toBe(true);
  });
});

describe('tokenize', () => {
  it('splits text and variables in order', () => {
    expect(tokenize('Hi {input:Name}, {x} {date}')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'variable', raw: '{input:Name}', name: 'input', arg: 'Name' },
      { kind: 'text', text: ', {x} ' },
      { kind: 'variable', raw: '{date}', name: 'date', arg: undefined },
    ]);
    expect(tokenize('')).toEqual([]);
  });
});
