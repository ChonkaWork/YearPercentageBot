import { describe, expect, it } from 'vitest';
import {
  MAX_TEMPLATE_NAME_CHARS,
  findTemplate,
  moveTemplate,
  removeTemplate,
  sanitizeTemplates,
  upsertTemplate,
  validateTemplate,
  type CustomTemplate,
} from '../src/core/customTemplates';
import { generatePrompt } from '../src/core/generate';
import { MAX_CUSTOM_INSTRUCTION_CHARS } from '../src/core/limits';
import { MAX_TEMPLATES } from '../src/core/plan';
import type { PromptResult } from '../src/core/types';

function ok(result: PromptResult): string {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.prompt;
}

const t = (id: string, name = `Template ${id}`, instruction = `Do ${id}.`): CustomTemplate => ({ id, name, instruction });

describe('validateTemplate', () => {
  it('normalizes a valid template', () => {
    expect(validateTemplate({ name: '  Email   to team ', instruction: '  Rewrite {content} as an email.\n' })).toEqual({
      ok: true,
      value: { name: 'Email to team', instruction: 'Rewrite {content} as an email.' },
    });
  });

  it('rejects empty or overlong fields with a field-specific message', () => {
    expect(validateTemplate({ name: ' ', instruction: 'x' })).toMatchObject({ ok: false, field: 'name' });
    expect(validateTemplate({ name: 'x'.repeat(MAX_TEMPLATE_NAME_CHARS + 1), instruction: 'x' })).toMatchObject({ ok: false, field: 'name' });
    expect(validateTemplate({ name: 'A', instruction: '   ' })).toMatchObject({ ok: false, field: 'instruction' });
    expect(validateTemplate({ name: 'A', instruction: 'x'.repeat(MAX_CUSTOM_INSTRUCTION_CHARS + 1) })).toMatchObject({
      ok: false,
      field: 'instruction',
    });
  });

  it('allows {content} once and requires an instruction around it', () => {
    expect(validateTemplate({ name: 'A', instruction: '{content} and { CONTENT }' })).toMatchObject({ ok: false, field: 'instruction' });
    expect(validateTemplate({ name: 'A', instruction: ' {content} ' })).toMatchObject({ ok: false, field: 'instruction' });
  });

  it('rejects duplicate names, except the template being edited', () => {
    const existing = [t('1', 'Email')];
    expect(validateTemplate({ name: 'email', instruction: 'x' }, existing)).toMatchObject({ ok: false, field: 'name' });
    expect(validateTemplate({ name: 'Email', instruction: 'y' }, existing, '1').ok).toBe(true);
  });
});

describe('template list', () => {
  it('adds, replaces and removes', () => {
    let list = upsertTemplate([], t('a'));
    list = upsertTemplate(list, t('b'));
    list = upsertTemplate(list, t('a', 'Renamed'));
    expect(list.map((item) => item.name)).toEqual(['Renamed', 'Template b']);
    expect(removeTemplate(list, 'a').map((item) => item.id)).toEqual(['b']);
    expect(findTemplate(list, 'b')?.name).toBe('Template b');
    expect(findTemplate(list, 'zzz')).toBeUndefined();
  });

  it('reorders and ignores moves past the ends', () => {
    const list = [t('a'), t('b'), t('c')];
    expect(moveTemplate(list, 'c', -1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(moveTemplate(list, 'a', 1).map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(moveTemplate(list, 'a', -1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveTemplate(list, 'c', 1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveTemplate(list, 'nope', 1)).toEqual(list);
  });

  it('sanitizes storage: drops malformed and duplicate entries, caps the count', () => {
    const stored = [t('a'), { id: 'a', name: 'dup', instruction: 'x' }, { id: 'b', name: '  ', instruction: 'x' }, null, 'junk', { id: 7 }, t('c')];
    expect(sanitizeTemplates(stored).map((item) => item.id)).toEqual(['a', 'c']);
    expect(sanitizeTemplates({})).toEqual([]);
    const many = Array.from({ length: MAX_TEMPLATES + 10 }, (_, i) => t(String(i)));
    expect(sanitizeTemplates(many)).toHaveLength(MAX_TEMPLATES);
  });
});

describe('custom template generation', () => {
  const TEXT = 'Q3 revenue grew 18% to $4.2M.\n\n\n\nShare\nChurn rose to 3.1%.';

  it('without {content}, the text follows the instruction like the Custom action', () => {
    const prompt = ok(generatePrompt({ action: 'custom', selectedText: TEXT, style: 'balanced', customInstruction: 'Turn this into a tweet.' }));
    expect(prompt).toBe('Turn this into a tweet.\n\nContent:\n"""\nQ3 revenue grew 18% to $4.2M.\n\nChurn rose to 3.1%.\n"""');
  });

  it('places the content where {content} is, still cleaned', () => {
    const prompt = ok(
      generatePrompt({
        action: 'custom',
        selectedText: TEXT,
        style: 'balanced',
        customInstruction: 'Rewrite {content} as an email to my team. Keep every number.',
      }),
    );
    expect(prompt).toBe('Rewrite\n"""\nQ3 revenue grew 18% to $4.2M.\n\nChurn rose to 3.1%.\n"""\nas an email to my team. Keep every number.');
    expect(prompt).not.toContain('{content}');
    expect(prompt).not.toMatch(/^Share$/m);
  });

  it('keeps the instruction lines around a {content} on its own line', () => {
    const prompt = ok(
      generatePrompt({ action: 'custom', selectedText: 'hello', style: 'balanced', customInstruction: 'Translate to French:\n\n{ Content }\n\nKeep the tone.' }),
    );
    expect(prompt).toBe('Translate to French:\n\n"""\nhello\n"""\n\nKeep the tone.');
  });

  it('applies page context and prompt style to templates', () => {
    const prompt = ok(
      generatePrompt({
        action: 'custom',
        selectedText: 'hello',
        style: 'concise',
        customInstruction: 'Summarize {content} in one line.',
        pageContext: { title: 'Weekly report', url: 'https://example.com/r?utm_source=x&id=2' },
      }),
    );
    expect(prompt.startsWith('Page: Weekly report\nURL: https://example.com/r?id=2\n\nSummarize\n"""\nhello\n"""\nin one line.')).toBe(true);
    expect(prompt.endsWith('Keep it concise.')).toBe(true);
  });

  it('fences code and errors, and content can’t break out of the fence', () => {
    const code = 'function f() {\n  return "```";\n}\nconst x = f();';
    const prompt = ok(generatePrompt({ action: 'custom', selectedText: code, style: 'balanced', customInstruction: 'Review:\n{content}' }));
    expect(prompt).toContain('````');
    expect(prompt).toContain('  return "```";');
  });

  it('does not treat $-patterns in the content as replacement tokens', () => {
    const prompt = ok(generatePrompt({ action: 'custom', selectedText: "costs $& and $' and $1", style: 'balanced', customInstruction: 'Check {content}' }));
    expect(prompt).toContain("costs $& and $' and $1");
  });

  it('only built-in Custom handles {content}; other actions ignore instructions', () => {
    const prompt = ok(generatePrompt({ action: 'summarize', selectedText: 'hello', style: 'balanced', customInstruction: 'x {content}' }));
    expect(prompt.startsWith('Summarize the following content.')).toBe(true);
  });
});
