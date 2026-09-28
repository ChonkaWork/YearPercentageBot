import { describe, expect, it } from 'vitest';
import {
  exportTemplates,
  importSummary,
  importTemplates,
  type CustomTemplate,
  type ImportResult,
} from '../src/core/customTemplates';
import { DESTINATIONS, DESTINATION_INFO, MAX_PREFILL_CHARS, isDestination, openHint, openTarget } from '../src/core/destinations';
import { generatePrompt } from '../src/core/generate';
import { TRANSLATE_LANGUAGES, isTranslateSetting, languageForLocale, resolveTargetLanguage } from '../src/core/languages';
import { MAX_TEMPLATES } from '../src/core/plan';
import { DEFAULT_SETTINGS, maskOptionsOf, sanitizeSettings } from '../src/core/settings';
import { PROMPT_ACTIONS, type PromptRequest, type PromptResult, type PromptSuccess } from '../src/core/types';
import { ACTIONS } from '../src/templates';

function success(result: PromptResult): PromptSuccess {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result;
}

const make = (overrides: Partial<PromptRequest>) =>
  generatePrompt({ action: 'translate', selectedText: 'Hello world', style: 'balanced', ...overrides });

const ARTICLE = 'The central bank raised its key rate to 5.25% on March 3, 2024.\nGovernor Anna Kowalski said inflation remained above target.';

describe('Translate action', () => {
  it('is a built-in action between Rewrite and Custom', () => {
    expect(PROMPT_ACTIONS.indexOf('translate')).toBe(PROMPT_ACTIONS.indexOf('rewrite') + 1);
    expect(PROMPT_ACTIONS.at(-1)).toBe('custom');
    expect(ACTIONS.find((action) => action.id === 'translate')?.label).toBe('Translate');
  });

  it('translates prose into the target language and keeps the facts', () => {
    const { prompt } = success(make({ selectedText: ARTICLE, targetLanguage: 'Ukrainian' }));
    expect(prompt).toBe(
      [
        'Translate the following content into Ukrainian.',
        '',
        'Keep the meaning, tone and formatting (paragraphs, lists, line breaks). Keep names, numbers, dates, prices, URLs and code exactly as they are.',
        '',
        'Content:',
        '"""',
        ARTICLE,
        '"""',
        '',
        'Return only the translation.',
      ].join('\n'),
    );
  });

  it('defaults to English and never adds the "same language" line', () => {
    const { prompt } = success(make({ selectedText: 'Центральний банк підвищив облікову ставку до 15% через високу інфляцію.' }));
    expect(prompt.startsWith('Translate the following content into English.')).toBe(true);
    expect(prompt).not.toContain('same language');
  });

  it('translates only comments and strings in code', () => {
    const code = 'def greet(name):\n    # Привітання користувача\n    return f"Привіт, {name}!"';
    const { prompt, content } = success(make({ selectedText: code, targetLanguage: 'English' }));
    expect(content.kind).toBe('code');
    expect(prompt.startsWith('Translate the comments and user-facing strings in the following code into English.')).toBe(true);
    expect(prompt).toContain('Do not change identifiers, logic');
    expect(prompt).toContain(`Code:\n\`\`\`\n${code}\n\`\`\``);
    expect(prompt.endsWith('Return the full code with the translations in place.')).toBe(true);
  });

  it('keeps errors and tables structured, and follows the prompt style', () => {
    const error = success(make({ selectedText: 'NullPointerException at UserService.java:142', targetLanguage: 'German' })).prompt;
    expect(error.startsWith('Translate the following Java error message into German.')).toBe(true);
    const table = success(make({ selectedText: 'Plan\tPrice\nFree\t$0\nPro\t$12', targetLanguage: 'Polish' })).prompt;
    expect(table).toContain('Translate the text in the following table into Polish.');
    expect(table.endsWith('Return the translated table in Markdown.')).toBe(true);
    const detailed = success(make({ selectedText: ARTICLE, style: 'detailed', targetLanguage: 'French' })).prompt;
    expect(detailed).toContain('terms that were hard to translate');
  });
});

describe('languages', () => {
  it('follows the browser language when the setting is empty', () => {
    expect(resolveTargetLanguage('', 'uk')).toEqual({ code: 'uk', name: 'Ukrainian' });
    expect(resolveTargetLanguage('', 'en-US')).toEqual({ code: 'en', name: 'English' });
    expect(resolveTargetLanguage('', 'pt-BR').name).toBe('Brazilian Portuguese');
    expect(resolveTargetLanguage('', 'pt-PT').name).toBe('Portuguese');
    expect(resolveTargetLanguage('', 'zh-HK').name).toBe('Traditional Chinese');
    expect(resolveTargetLanguage('', 'zh').name).toBe('Simplified Chinese');
    expect(resolveTargetLanguage('', 'nb').name).toBe('Norwegian');
    expect(resolveTargetLanguage('', 'fa-IR').name).toBe('English');
    expect(resolveTargetLanguage('', '').name).toBe('English');
  });

  it('uses the setting when it is a listed language', () => {
    expect(resolveTargetLanguage('de', 'uk').name).toBe('German');
    expect(resolveTargetLanguage('xx', 'uk').name).toBe('Ukrainian');
    expect(languageForLocale('ja_JP').name).toBe('Japanese');
  });

  it('validates the setting', () => {
    expect(isTranslateSetting('')).toBe(true);
    expect(isTranslateSetting('pt-BR')).toBe(true);
    expect(isTranslateSetting('pt-br')).toBe(false);
    expect(isTranslateSetting('klingon')).toBe(false);
    expect(new Set(TRANSLATE_LANGUAGES.map((language) => language.code)).size).toBe(TRANSLATE_LANGUAGES.length);
  });
});

describe('Copy & open', () => {
  it('prefills ChatGPT and Perplexity through the address', () => {
    const prompt = 'Summarize the following content.\n\n"""\nQ3 & Q4 — 18% growth\n"""';
    expect(openTarget('chatgpt', prompt)).toEqual({ url: `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`, prefilled: true });
    expect(openTarget('perplexity', prompt)).toEqual({ url: `https://www.perplexity.ai/search?q=${encodeURIComponent(prompt)}`, prefilled: true });
    expect(new URL(openTarget('chatgpt', prompt).url).searchParams.get('q')).toBe(prompt);
  });

  it('opens Claude and Gemini empty, for pasting', () => {
    expect(openTarget('claude', 'x')).toEqual({ url: 'https://claude.ai/new', prefilled: false });
    expect(openTarget('gemini', 'x')).toEqual({ url: 'https://gemini.google.com/app', prefilled: false });
  });

  it('falls back to pasting when the prompt is too long for an address', () => {
    expect(openTarget('chatgpt', 'a'.repeat(MAX_PREFILL_CHARS)).prefilled).toBe(true);
    expect(openTarget('chatgpt', 'a'.repeat(MAX_PREFILL_CHARS + 1))).toEqual({ url: 'https://chatgpt.com/', prefilled: false });
    // Cyrillic grows ~6x when encoded: 5,000 characters is too long for the address.
    expect(openTarget('chatgpt', 'ї'.repeat(5_000)).prefilled).toBe(false);
  });

  it('tells the user what will happen', () => {
    expect(openHint('chatgpt', 'short')).toBe('ChatGPT opens with the prompt filled in.');
    expect(openHint('chatgpt', 'a'.repeat(7_000), '⌘V')).toBe('Too long to fill in: ChatGPT opens, press ⌘V to paste.');
    expect(openHint('claude', 'short')).toBe('Claude opens in a new tab. Press Ctrl+V to paste.');
  });

  it('only knows fixed https destinations', () => {
    for (const id of DESTINATIONS) expect(DESTINATION_INFO[id].home.startsWith('https://')).toBe(true);
    expect(isDestination('chatgpt')).toBe(true);
    expect(isDestination('https://evil.example')).toBe(false);
  });
});

describe('generatePrompt: masking', () => {
  const LOG = 'charge failed for anna@example.com, card 4242 4242 4242 4242, from 203.0.113.42';

  it('masks the content and reports what it replaced', () => {
    const result = success(generatePrompt({ action: 'explain', selectedText: LOG, style: 'balanced', mask: {} }));
    expect(result.prompt).toContain('charge failed for [EMAIL_1], card [CARD_1], from [IP_1]');
    expect(result.prompt).not.toContain('anna@example.com');
    expect(result.masked.map((item) => item.placeholder)).toEqual(['[EMAIL_1]', '[CARD_1]', '[IP_1]']);
    expect(result.source).toBe('charge failed for [EMAIL_1], card [CARD_1], from [IP_1]');
  });

  it('leaves everything as is when masking is off', () => {
    const result = success(generatePrompt({ action: 'explain', selectedText: LOG, style: 'balanced', mask: null }));
    expect(result.prompt).toContain(LOG);
    expect(result.masked).toEqual([]);
  });

  it('masks the page title and URL with the same mapping', () => {
    const result = success(
      generatePrompt({
        action: 'summarize',
        selectedText: 'Ticket by anna@example.com',
        style: 'balanced',
        mask: {},
        pageContext: { title: 'anna@example.com – Inbox', url: 'https://mail.example.com/u/anna@example.com' },
      }),
    );
    expect(result.prompt).toContain('Page: [EMAIL_1] – Inbox\nURL: https://mail.example.com/u/[EMAIL_1]');
    expect(result.masked).toHaveLength(1);
    expect(result.masked[0]?.count).toBe(3);
  });

  it('respects the categories turned off in settings', () => {
    const options = maskOptionsOf(sanitizeSettings({ maskOff: ['email'] }));
    const result = success(generatePrompt({ action: 'explain', selectedText: LOG, style: 'balanced', mask: options }));
    expect(result.prompt).toContain('anna@example.com');
    expect(result.prompt).toContain('[CARD_1]');
    expect(maskOptionsOf(sanitizeSettings({ maskSecrets: false }))).toBeNull();
  });

  it('keeps code detection on the original text', () => {
    const trace = 'Exception in thread "main" java.lang.IllegalStateException: token=abc123def456\n    at com.example.Auth.check(Auth.java:42)';
    const result = success(generatePrompt({ action: 'explain', selectedText: trace, style: 'balanced', mask: {} }));
    expect(result.content.kind).toBe('error');
    expect(result.prompt).toContain('token=[SECRET_1]');
  });
});

describe('settings for the new features', () => {
  it('defaults: masking on, ChatGPT, browser language', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ maskSecrets: true, maskOff: [], openIn: 'chatgpt', translateTo: '' });
    expect(maskOptionsOf(DEFAULT_SETTINGS)).toEqual({ off: [] });
  });

  it('accepts Translate as the default action', () => {
    expect(sanitizeSettings({ defaultAction: 'translate' }).defaultAction).toBe('translate');
  });
});

describe('template import and export', () => {
  const t = (id: string, name: string, instruction: string): CustomTemplate => ({ id, name, instruction });
  const existing = [t('a', 'Email to my team', 'Rewrite {content} as an email.'), t('b', 'Code review', 'Review this code.')];
  let counter = 0;
  const newId = () => `new-${++counter}`;
  const ok = (result: ImportResult) => {
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  it('exports names and instructions only', () => {
    const json = exportTemplates(existing, new Date('2026-09-28T10:00:00Z'));
    expect(JSON.parse(json)).toEqual({
      format: 'pastebot-templates',
      version: 1,
      exportedAt: '2026-09-28T10:00:00.000Z',
      templates: [
        { name: 'Email to my team', instruction: 'Rewrite {content} as an email.' },
        { name: 'Code review', instruction: 'Review this code.' },
      ],
    });
  });

  it('round-trips without changes', () => {
    const result = ok(importTemplates(existing, exportTemplates(existing), newId));
    expect(result.templates).toEqual(existing);
    expect(result).toMatchObject({ added: 0, updated: 0, unchanged: 2, skipped: 0 });
    expect(importSummary(result)).toBe('Nothing new to import. 2 already up to date.');
  });

  it('adds new templates, updates same-named ones in place, skips invalid ones', () => {
    counter = 0;
    const file = JSON.stringify({
      format: 'pastebot-templates',
      templates: [
        { name: 'code REVIEW', instruction: 'Review this code like a senior engineer.' },
        { name: 'Explain to {{Audience}}', instruction: 'Explain {content} to {{Audience=a junior developer}}.' },
        { name: 'Broken', instruction: 'Hello {{Audience' },
        { name: '', instruction: 'No name' },
        'not an object',
      ],
    });
    const result = ok(importTemplates(existing, file, newId));
    expect(result.templates).toEqual([
      existing[0],
      t('b', 'Code review', 'Review this code like a senior engineer.'),
      t('new-1', 'Explain to {{Audience}}', 'Explain {content} to {{Audience=a junior developer}}.'),
    ]);
    expect(importSummary(result)).toBe('Imported 2 templates: 1 new, 1 updated. 3 skipped (invalid or over the limit of 50).');
  });

  it('accepts a bare array and respects the template cap', () => {
    const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => t(`x${i}`, `T${i}`, 'Do it.'));
    const result = ok(importTemplates(full, JSON.stringify([{ name: 'One more', instruction: 'Do more.' }]), newId));
    expect(result.templates).toHaveLength(MAX_TEMPLATES);
    expect(result.skipped).toBe(1);
  });

  it('rejects files that are not Pastebot templates', () => {
    expect(importTemplates(existing, 'not json', newId)).toEqual({ ok: false, message: "This file isn't valid JSON." });
    expect(importTemplates(existing, '{"format":"other","templates":[]}', newId)).toMatchObject({ ok: false, message: /exported by Pastebot/ });
    expect(importTemplates(existing, '{"hello":1}', newId)).toMatchObject({ ok: false, message: /doesn't contain/ });
    expect(importTemplates(existing, '[]', newId)).toMatchObject({ ok: false, message: /no templates/ });
  });
});
