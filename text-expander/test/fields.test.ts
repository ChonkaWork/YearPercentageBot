import { describe, expect, it } from 'vitest';
import { defaultInputs, expandTemplate, hasFields, hasVariables, normalizeInputValue, parseFields, parseFieldSpec, renderForCopy } from '../src/core/variables';

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
