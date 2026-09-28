import { describe, expect, it } from 'vitest';
import { generatePrompt } from '../src/core/generate';
import { MAX_INPUT_CHARS } from '../src/core/limits';
import { PROMPT_ACTIONS, PROMPT_STYLES, type PromptRequest, type PromptResult } from '../src/core/types';

function ok(result: PromptResult): string {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.prompt;
}

function make(overrides: Partial<PromptRequest>): PromptResult {
  return generatePrompt({ action: 'analyze', selectedText: 'Hello world', style: 'balanced', ...overrides });
}

const ARTICLE = `The central bank raised its key rate to 5.25% on March 3, 2024.
Governor Anna Kowalski said inflation remained above the 2% target.
Analysts at ING expect one more hike before the summer.`;

const JAVA_ERROR = `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null
    at com.example.UserService.validate(UserService.java:142)
    at com.example.UserController.create(UserController.java:57)`;

describe('generatePrompt: actions', () => {
  it.each(PROMPT_ACTIONS.filter((action) => action !== 'custom'))('%s includes the full selected text', (action) => {
    const prompt = ok(make({ action, selectedText: ARTICLE }));
    expect(prompt).toContain(ARTICLE);
    expect(prompt).toContain('Content:\n"""\n');
  });

  it('analyze asks for facts vs assumptions', () => {
    const prompt = ok(make({ action: 'analyze', selectedText: ARTICLE }));
    expect(prompt.startsWith('Analyze the following content.')).toBe(true);
    expect(prompt).toContain('Underlying assumptions');
    expect(prompt).toContain('distinguish facts');
  });

  it('summarize preserves facts and asks for bullet points', () => {
    const prompt = ok(make({ action: 'summarize', selectedText: ARTICLE }));
    expect(prompt.startsWith('Summarize the following content.')).toBe(true);
    expect(prompt).toContain('numbers, names, dates');
    expect(prompt.endsWith('Use concise, structured bullet points.')).toBe(true);
  });

  it('explain on plain text explains terminology', () => {
    const prompt = ok(make({ action: 'explain', selectedText: ARTICLE }));
    expect(prompt).toContain('Explain the following content clearly.');
    expect(prompt).toContain('terminology');
  });

  it('extract forbids invented values', () => {
    const prompt = ok(make({ action: 'extract', selectedText: ARTICLE }));
    expect(prompt).toContain('Do not invent missing information');
    expect(prompt).toContain('predictable format');
  });

  it('compare asks for trade-offs', () => {
    const prompt = ok(make({ action: 'compare', selectedText: 'Postgres is relational. MongoDB stores documents.' }));
    expect(prompt).toContain('Trade-offs');
    expect(prompt).toContain('Advantages and disadvantages');
  });

  it('rewrite keeps meaning and forbids new facts', () => {
    const prompt = ok(make({ action: 'rewrite', selectedText: ARTICLE }));
    expect(prompt).toContain('preserving its meaning');
    expect(prompt).toContain('Do not add facts');
    expect(prompt).toContain('Return only the rewritten text.');
  });

  it('explain on a Java error produces a developer-focused prompt', () => {
    const prompt = ok(make({ action: 'explain', selectedText: 'NullPointerException at UserService.java:142' }));
    expect(prompt).toBe(
      [
        'Explain the following Java error.',
        '',
        'Cover:',
        '1. What is most likely causing it',
        '2. Which part of the code is responsible',
        '3. How to fix it',
        '4. How to prevent the same issue',
        '',
        'Be precise and assume the reader is an experienced Java developer.',
        '',
        'Error:',
        '```',
        'NullPointerException at UserService.java:142',
        '```',
      ].join('\n'),
    );
  });

  it('unknown action is rejected', () => {
    const result = make({ action: 'shout' as never });
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ACTION' });
  });
});

describe('generatePrompt: custom', () => {
  it('uses the instruction as the task and the selection as context', () => {
    const prompt = ok(make({ action: 'custom', customInstruction: '  Turn this into a professional email.  ', selectedText: ARTICLE }));
    expect(prompt.startsWith('Turn this into a professional email.\n\nContent:\n"""')).toBe(true);
    expect(prompt).toContain(ARTICLE);
  });

  it('requires an instruction', () => {
    expect(make({ action: 'custom', customInstruction: '   ' })).toMatchObject({ ok: false, code: 'EMPTY_INSTRUCTION' });
    expect(make({ action: 'custom' })).toMatchObject({ ok: false, code: 'EMPTY_INSTRUCTION' });
  });

  it('rejects very long instructions', () => {
    expect(make({ action: 'custom', customInstruction: 'x'.repeat(2_001) })).toMatchObject({
      ok: false,
      code: 'INSTRUCTION_TOO_LONG',
    });
  });

  it('does not force the content language (the instruction may ask for a translation)', () => {
    const prompt = ok(make({ action: 'custom', customInstruction: 'Translate to English.', selectedText: 'Привіт, як справи? Сьогодні гарна погода.' }));
    expect(prompt).not.toContain('same language');
  });

  it('ignores the instruction for non-custom actions', () => {
    const prompt = ok(make({ action: 'summarize', customInstruction: 'IGNORE ME', selectedText: ARTICLE }));
    expect(prompt).not.toContain('IGNORE ME');
  });
});

describe('generatePrompt: empty and oversized input', () => {
  it.each(['', '   ', '\n\n\t\n', '​​'])('rejects empty selection %j', (selectedText) => {
    expect(make({ selectedText })).toMatchObject({ ok: false, code: 'EMPTY_TEXT' });
  });

  it('rejects non-string input without throwing', () => {
    expect(make({ selectedText: undefined as never })).toMatchObject({ ok: false, code: 'EMPTY_TEXT' });
  });

  it('accepts text right at the limit', () => {
    const text = 'a'.repeat(MAX_INPUT_CHARS);
    expect(make({ selectedText: text }).ok).toBe(true);
  });

  it('rejects text over the limit with length info', () => {
    const result = make({ selectedText: 'word '.repeat(MAX_INPUT_CHARS / 4) });
    expect(result).toMatchObject({ ok: false, code: 'TEXT_TOO_LARGE', limit: MAX_INPUT_CHARS });
    if (!result.ok) expect(result.length).toBeGreaterThan(MAX_INPUT_CHARS);
  });

  it('rejects multi-megabyte input quickly', () => {
    const started = performance.now();
    const result = make({ selectedText: 'x'.repeat(5_000_000) });
    expect(result).toMatchObject({ ok: false, code: 'TEXT_TOO_LARGE' });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('handles a large valid selection fast', () => {
    const paragraph = `${ARTICLE}\n\n`;
    const text = paragraph.repeat(Math.floor(90_000 / paragraph.length));
    const started = performance.now();
    const result = make({ action: 'summarize', selectedText: text });
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('generatePrompt: page context', () => {
  const pageContext = { title: 'Senior Java Developer', url: 'https://example.com/jobs/123?utm_source=x' };

  it('adds title and cleaned URL before the content when enabled', () => {
    const prompt = ok(make({ selectedText: ARTICLE, pageContext }));
    expect(prompt).toContain('Page: Senior Java Developer\nURL: https://example.com/jobs/123\n\nContent:');
    expect(prompt).not.toContain('utm_source');
  });

  it('adds nothing when disabled', () => {
    const prompt = ok(make({ selectedText: ARTICLE, pageContext: null }));
    expect(prompt).not.toContain('Page:');
    expect(prompt).not.toContain('URL:');
  });

  it('skips non-web URLs but keeps the title', () => {
    const prompt = ok(make({ selectedText: ARTICLE, pageContext: { title: 'notes.pdf', url: 'file:///home/me/notes.pdf' } }));
    expect(prompt).toContain('Page: notes.pdf');
    expect(prompt).not.toContain('file://');
  });
});

describe('generatePrompt: styles', () => {
  it.each(PROMPT_STYLES)('%s produces a prompt with the content', (style) => {
    const prompt = ok(make({ style, selectedText: JAVA_ERROR, action: 'explain' }));
    expect(prompt).toContain('UserService.java:142');
  });

  it('concise drops the numbered list and asks for brevity', () => {
    const prompt = ok(make({ style: 'concise', selectedText: JAVA_ERROR, action: 'explain' }));
    expect(prompt).not.toMatch(/^1\. /m);
    expect(prompt.startsWith('Explain what is most likely causing the following Java error and how to fix it.')).toBe(true);
    expect(prompt).toContain('Keep the answer short');
  });

  it('detailed adds extra points and structure', () => {
    const balanced = ok(make({ style: 'balanced', selectedText: JAVA_ERROR, action: 'explain' }));
    const detailed = ok(make({ style: 'detailed', selectedText: JAVA_ERROR, action: 'explain' }));
    expect(detailed).toContain('5. Other possible causes worth ruling out');
    expect(balanced).not.toContain('5. ');
    expect(detailed).toContain('Be thorough');
  });

  it('concise summaries ask for a few bullets', () => {
    const prompt = ok(make({ style: 'concise', action: 'summarize', selectedText: ARTICLE }));
    expect(prompt).toContain('Use 3-5 short bullet points.');
  });

  it('falls back to balanced for an invalid style', () => {
    const prompt = ok(make({ style: 'verbose' as never, selectedText: JAVA_ERROR, action: 'explain' }));
    expect(prompt).toContain('1. What is most likely causing it');
  });
});

describe('generatePrompt: content preservation', () => {
  it('keeps special characters exactly', () => {
    const text = 'Price: €1 299,99 (−15%) <b>&amp;</b> "quotes" \'single\' $HOME ${x} \\n 😀 👨‍👩‍👧';
    const prompt = ok(make({ selectedText: text }));
    expect(prompt).toContain(text);
  });

  it('keeps code indentation and uses a language fence', () => {
    const code = `def total(items):
    result = 0
    for item in items:
        result += item.price
    return result`;
    const prompt = ok(make({ action: 'explain', selectedText: code }));
    expect(prompt).toContain('Explain the following Python code.');
    expect(prompt).toContain(`Code:\n\`\`\`python\n${code}\n\`\`\``);
  });

  it('uses a longer fence when the code contains backticks', () => {
    const code = 'const md = `\n```js\nconsole.log(1);\n```\n`;\nexport default md;';
    const prompt = ok(make({ action: 'explain', selectedText: code }));
    expect(prompt).toContain('````');
    expect(prompt).toContain(code);
  });

  it('keeps URLs, numbers and dates untouched', () => {
    const text = 'See https://example.com/a?b=1&c=2#frag on 2024-03-03 at 10:45, order #A-1029 for $1,234.50.';
    const prompt = ok(make({ action: 'extract', selectedText: text }));
    expect(prompt).toContain(text);
  });

  it('keeps tab-separated table rows including empty cells', () => {
    const table = 'Plan\tPrice\tSeats\nFree\t$0\t1\nPro\t$12\t\nTeam\t$30\t10';
    const prompt = ok(make({ action: 'compare', selectedText: table }));
    expect(prompt).toContain('Compare the items in the following table.');
    expect(prompt).toContain(`Table:\n\`\`\`\n${table}\n\`\`\``);
  });

  it('falls back to a fence when text contains triple quotes', () => {
    const text = 'He wrote """quoted""" in the docstring and moved on.';
    const prompt = ok(make({ selectedText: text }));
    expect(prompt).toContain(`Content:\n\`\`\`\n${text}\n\`\`\``);
  });

  it('asks for an answer in the content language for non-Latin text', () => {
    const text = 'Центральний банк підвищив облікову ставку до 15% через високу інфляцію.';
    expect(ok(make({ action: 'summarize', selectedText: text }))).toContain('Respond in the same language as the content.');
    expect(ok(make({ action: 'rewrite', selectedText: text }))).not.toContain('Respond in the same language');
  });

  it('does not add the language line for English text', () => {
    expect(ok(make({ selectedText: ARTICLE }))).not.toContain('same language');
  });
});
