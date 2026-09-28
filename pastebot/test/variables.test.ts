import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../src/core/customTemplates';
import { generatePrompt } from '../src/core/generate';
import type { PromptRequest, PromptResult } from '../src/core/types';
import {
  MAX_ASK_VARIABLES,
  askVariables,
  fillVariables,
  isoDate,
  missingVariables,
  sanitizeValues,
  variableProblem,
  type VariableValues,
} from '../src/core/variables';

function ok(result: PromptResult): string {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.prompt;
}

const PAGE = { title: 'Q3 results · Acme Blog', url: 'https://blog.example.com/q3?utm_source=x' };
const context = (values: Record<string, string> = {}): VariableValues => ({ page: PAGE, date: '2026-09-28', values });

describe('askVariables', () => {
  it('finds each variable once, in order, with defaults', () => {
    expect(askVariables('Write for {{Audience}} in {{Language=English}}. Keep {{audience}} in mind. {{ Tone = friendly }}')).toEqual([
      { name: 'Audience', defaultValue: '' },
      { name: 'Language', defaultValue: 'English' },
      { name: 'Tone', defaultValue: 'friendly' },
    ]);
  });

  it('takes a later default when the first use has none', () => {
    expect(askVariables('{{Audience}} … {{Audience=my team}}')).toEqual([{ name: 'Audience', defaultValue: 'my team' }]);
  });

  it('ignores built-ins, single braces and malformed variables', () => {
    expect(askVariables('Summarize {content} from {title} ({url}) on {date}. {{}} {{title}} {not a variable}')).toEqual([]);
  });

  it(`stops at ${MAX_ASK_VARIABLES} variables`, () => {
    const many = Array.from({ length: 9 }, (_, i) => `{{V${i}}}`).join(' ');
    expect(askVariables(many)).toHaveLength(MAX_ASK_VARIABLES);
  });
});

describe('variableProblem', () => {
  it('accepts well-formed templates', () => {
    expect(variableProblem('Explain {content} to {{Audience}} in {{Language=English}}, today is {date}.')).toBeNull();
    expect(variableProblem('No variables at all, just {content}.')).toBeNull();
    expect(variableProblem('JSON example: {"a": {"b": 1}}')).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(variableProblem('Hello {{Audience')).toMatch(/not closed/);
    expect(variableProblem('Hello {{Audience}} and {{Tone')).toMatch(/not closed/);
    expect(variableProblem('Hello {{}}')).toMatch(/name/);
    expect(variableProblem('Hello {{=x}}')).toMatch(/name/);
    expect(variableProblem('Hello {{title}}')).toMatch(/single braces/);
    expect(variableProblem(`Hello {{${'x'.repeat(40)}}}`)).toMatch(/under 32/);
    expect(variableProblem('Hello {{Who?}}')).toMatch(/can't be a variable name/);
    expect(variableProblem(`{{A=${'x'.repeat(101)}}}`)).toMatch(/default values/);
    expect(variableProblem(Array.from({ length: 7 }, (_, i) => `{{V${i}}}`).join(' '))).toMatch(/at most 6/);
  });

  it('is part of template validation', () => {
    expect(validateTemplate({ name: 'Bad', instruction: 'Write for {{Audience' })).toMatchObject({ ok: false, field: 'instruction' });
    expect(validateTemplate({ name: 'Good', instruction: 'Write {selection} for {{Audience}}.' })).toMatchObject({ ok: true });
  });
});

describe('fillVariables', () => {
  it('fills built-ins and answers, keeping {content}', () => {
    expect(fillVariables('For {{Audience}} in {{Language=English}}: {content} from “{title}” <{url}> on {date}.', context({ Audience: 'my team' }))).toBe(
      'For my team in English: {content} from “Q3 results · Acme Blog” <https://blog.example.com/q3?utm_source=x> on 2026-09-28.',
    );
  });

  it('answers override defaults; names match case-insensitively', () => {
    expect(fillVariables('{{Language=English}} / {{language}}', context({ LANGUAGE: ' Polish ' }))).toBe('Polish / Polish');
  });

  it('leaves missing page values empty and applies the transform to page values only', () => {
    expect(fillVariables('[{title}] [{url}]', { page: null, date: '2026-01-01', values: {} })).toBe('[] []');
    expect(fillVariables('{title} {{A}}', context({ A: 'x' }), (value) => value.toUpperCase())).toBe('Q3 RESULTS · ACME BLOG x');
  });

  it('lists what is still missing', () => {
    const asks = askVariables('{{Audience}} {{Language=English}} {{Tone}}');
    expect(missingVariables(asks, { Audience: 'devs', Tone: '  ' })).toEqual(['Tone']);
    expect(missingVariables(asks, { audience: 'devs', tone: 'dry' })).toEqual([]);
  });

  it('formats the date as a local ISO day', () => {
    expect(isoDate(new Date(2026, 8, 5, 23, 59))).toBe('2026-09-05');
  });

  it('sanitizes answers from messages', () => {
    expect(sanitizeValues({ A: '  x  ', B: 3, C: 'y'.repeat(600) })).toEqual({ A: 'x', C: 'y'.repeat(500) });
    expect(sanitizeValues(null)).toEqual({});
    expect(sanitizeValues(['x'])).toEqual({});
  });
});

describe('generatePrompt: template variables', () => {
  const run = (overrides: Partial<PromptRequest>) =>
    generatePrompt({ action: 'custom', selectedText: 'Revenue grew 18% in Q3.', style: 'balanced', ...overrides });

  it('fills the instruction and places the content at {selection}', () => {
    const prompt = ok(
      run({
        customInstruction: 'Explain {selection} to {{Audience}} in {{Language=English}}. Source: {title}, {url}, {date}.',
        variables: context({ Audience: 'our sales team' }),
      }),
    );
    expect(prompt).toBe(
      'Explain\n"""\nRevenue grew 18% in Q3.\n"""\nto our sales team in English. Source: Q3 results · Acme Blog, https://blog.example.com/q3, 2026-09-28.',
    );
  });

  it('fills variables when the content goes after the instruction', () => {
    const prompt = ok(run({ customInstruction: 'Summarize this for {{Audience=executives}}.', variables: context() }));
    expect(prompt.startsWith('Summarize this for executives.\n\nContent:\n"""')).toBe(true);
  });

  it('an answer can never move the content', () => {
    const prompt = ok(run({ customInstruction: 'For {{Audience}}: {content}', variables: context({ Audience: '{content} {title}' }) }));
    expect(prompt).toBe('For {content} {title}:\n"""\nRevenue grew 18% in Q3.\n"""');
  });

  it('leaves variables as written without variable values (plain Custom action, or Pro ended)', () => {
    const prompt = ok(run({ customInstruction: 'Explain for {{Audience}} on {date}.' }));
    expect(prompt.startsWith('Explain for {{Audience}} on {date}.')).toBe(true);
  });

  it('masks page values that go into {title} and {url}', () => {
    const prompt = ok(
      run({
        customInstruction: 'Reply to the ticket “{title}”.',
        variables: { page: { title: 'Ticket from anna@example.com', url: 'https://help.example.com/t/1' }, date: '2026-09-28', values: {} },
        selectedText: 'Please call me back, anna@example.com',
        mask: {},
      }),
    );
    expect(prompt).toContain('Reply to the ticket “Ticket from [EMAIL_1]”.');
    expect(prompt).toContain('Please call me back, [EMAIL_1]');
  });
});
