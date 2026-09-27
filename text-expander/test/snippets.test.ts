import { describe, expect, it } from 'vitest';
import {
  lacksPrefixSymbol,
  LIMITS,
  normalizeDraft,
  previewText,
  sanitizeSnippets,
  searchSnippets,
  sortSnippets,
  validateDraft,
  validateFields,
  type Snippet,
} from '../src/core/snippets';
import { STARTER_SNIPPETS } from '../src/core/starters';

const snippet = (abbreviation: string, text = 'text', label = ''): Snippet => ({
  id: abbreviation,
  abbreviation,
  text,
  label,
  createdAt: 1,
  updatedAt: 1,
});

describe('normalizeDraft', () => {
  it('trims, normalizes line breaks and strips control characters', () => {
    expect(normalizeDraft({ abbreviation: '  ;sig ', text: 'a\r\nb\rc\u0007', label: '  My   label\n ' })).toEqual({
      abbreviation: ';sig',
      text: 'a\nb\nc',
      label: 'My label',
    });
  });

  it('turns non-strings into empty strings', () => {
    expect(normalizeDraft({ abbreviation: 5, text: null, label: {} })).toEqual({ abbreviation: '', text: '', label: '' });
  });
});

describe('validateDraft', () => {
  const valid = { abbreviation: ';ok', text: 'Fine', label: '' };

  it('accepts a valid draft', () => {
    expect(validateDraft(valid, [])).toEqual({});
  });

  it('rejects empty, spaced, too short and too long abbreviations', () => {
    expect(validateFields({ ...valid, abbreviation: '' }).abbreviation).toMatch(/Enter an abbreviation/);
    expect(validateFields({ ...valid, abbreviation: ';my sig' }).abbreviation).toMatch(/spaces/);
    expect(validateFields({ ...valid, abbreviation: ';a\tb' }).abbreviation).toMatch(/spaces/);
    expect(validateFields({ ...valid, abbreviation: ';' }).abbreviation).toMatch(/at least 2/);
    expect(validateFields({ ...valid, abbreviation: `;${'a'.repeat(LIMITS.abbreviationMax)}` }).abbreviation).toMatch(/at most 32/);
    // Two code points, even though the emoji is two UTF-16 units.
    expect(validateFields({ ...valid, abbreviation: ':🙂' }).abbreviation).toBeUndefined();
  });

  it('rejects empty and oversized text and long labels', () => {
    expect(validateFields({ ...valid, text: '  \n ' }).text).toMatch(/Enter the text/);
    expect(validateFields({ ...valid, text: 'x'.repeat(LIMITS.textMax + 1) }).text).toMatch(/too long/);
    expect(validateFields({ ...valid, label: 'x'.repeat(LIMITS.labelMax + 1) }).label).toMatch(/at most 80/);
  });

  it('rejects duplicates and names the snippet that has it', () => {
    expect(validateDraft(valid, [snippet(';ok', 'x', 'Okay')]).abbreviation).toBe(';ok is already used by "Okay".');
    expect(validateDraft(valid, [snippet(';ok')]).abbreviation).toBe(';ok is already used by another snippet.');
    // Case-sensitive.
    expect(validateDraft(valid, [snippet(';OK')])).toEqual({});
  });

  it('flags abbreviations without a symbol', () => {
    expect(lacksPrefixSymbol('brb')).toBe(true);
    expect(lacksPrefixSymbol('привіт')).toBe(true);
    expect(lacksPrefixSymbol(';brb')).toBe(false);
    expect(lacksPrefixSymbol('brb!')).toBe(false);
  });
});

describe('sanitizeSnippets', () => {
  it('returns an empty list for garbage', () => {
    for (const raw of [undefined, null, 42, 'x', {}]) expect(sanitizeSnippets(raw)).toEqual([]);
  });

  it('drops invalid entries and duplicate abbreviations, fixes ids and timestamps', () => {
    const result = sanitizeSnippets([
      { id: 'a', abbreviation: ';a1', text: 'one', label: 'One', createdAt: 5, updatedAt: 7 },
      { id: 'a', abbreviation: ';a2', text: 'two' },
      { abbreviation: ';a1', text: 'duplicate' },
      { abbreviation: 'has space', text: 'x' },
      { abbreviation: ';empty', text: '' },
      'string',
      null,
      { abbreviation: ';a3', text: 'three', createdAt: -1, updatedAt: Number.NaN },
    ]);
    expect(result.map((entry) => entry.abbreviation)).toEqual([';a1', ';a2', ';a3']);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(3);
    expect(result[0]).toEqual({ id: 'a', abbreviation: ';a1', text: 'one', label: 'One', createdAt: 5, updatedAt: 7 });
    expect(result[2]?.createdAt).toBe(0);
    expect(result[2]?.label).toBe('');
  });

  it('caps the number of snippets', () => {
    const many = Array.from({ length: LIMITS.snippetsMax + 5 }, (_, i) => ({ abbreviation: `;s${i}`, text: 'x' }));
    expect(sanitizeSnippets(many)).toHaveLength(LIMITS.snippetsMax);
  });
});

describe('sort and search', () => {
  const list = [snippet(';ty', 'Thank you'), snippet(';addr', '123 Main Street', 'Home address'), snippet(';sig', 'Best regards', 'Signature'), snippet(';s10'), snippet(';s9')];

  it('sorts by abbreviation, numbers naturally', () => {
    expect(sortSnippets(list).map((entry) => entry.abbreviation)).toEqual([';addr', ';s9', ';s10', ';sig', ';ty']);
  });

  it('searches abbreviation, label and text, ranking abbreviation hits first', () => {
    expect(searchSnippets(list, '').length).toBe(5);
    expect(searchSnippets(list, 'SIG').map((entry) => entry.abbreviation)).toEqual([';sig']);
    expect(searchSnippets(list, 'main street').map((entry) => entry.abbreviation)).toEqual([';addr']);
    expect(searchSnippets(list, 'address').map((entry) => entry.abbreviation)).toEqual([';addr']);
    expect(searchSnippets(list, ';s').map((entry) => entry.abbreviation)).toEqual([';s9', ';s10', ';sig']);
    expect(searchSnippets(list, 'nothing-like-this')).toEqual([]);
    const ranked = searchSnippets([snippet(';x', 'mentions ty'), snippet(';ty', 'x')], 'ty');
    expect(ranked.map((entry) => entry.abbreviation)).toEqual([';ty', ';x']);
  });

  it('builds a one-line preview', () => {
    expect(previewText('Best regards,\n\n  Alex')).toBe('Best regards, ⏎ Alex');
    expect(previewText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('starter snippets', () => {
  it('are valid, unique and reachable in "as you type" mode', async () => {
    const { findAllShadowed } = await import('../src/core/matcher');
    for (const draft of STARTER_SNIPPETS) expect(validateFields(draft)).toEqual({});
    const abbreviations = STARTER_SNIPPETS.map((draft) => draft.abbreviation);
    expect(new Set(abbreviations).size).toBe(abbreviations.length);
    expect(findAllShadowed(abbreviations).size).toBe(0);
  });
});
