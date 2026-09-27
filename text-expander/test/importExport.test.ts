import { describe, expect, it } from 'vitest';
import { buildExport, exportFileName, ImportError, parseImport, planImport } from '../src/core/importExport';
import { LIMITS, type Snippet } from '../src/core/snippets';

const snippet = (abbreviation: string, text = 'text', label = ''): Snippet => ({
  id: `id${abbreviation}`,
  abbreviation,
  text,
  label,
  createdAt: 1,
  updatedAt: 1,
});

let counter = 0;
const createId = () => `new${++counter}`;

describe('export', () => {
  it('round-trips through import', () => {
    const json = buildExport([snippet(';ty', 'Thanks!'), snippet(';addr', 'Line 1\nLine 2', 'Home')], new Date('2026-09-27T10:00:00Z'));
    const file = JSON.parse(json);
    expect(file.format).toBe('snippets-text-expander');
    expect(file.version).toBe(1);
    expect(file.exportedAt).toBe('2026-09-27T10:00:00.000Z');
    expect(file.snippets).toEqual([
      { abbreviation: ';addr', text: 'Line 1\nLine 2', label: 'Home' },
      { abbreviation: ';ty', text: 'Thanks!', label: '' },
    ]);
    expect(parseImport(json)).toEqual({ drafts: file.snippets, skipped: [] });
  });

  it('names files by date', () => {
    expect(exportFileName(new Date(2026, 0, 5))).toBe('snippets-2026-01-05.json');
  });
});

describe('parseImport', () => {
  it('accepts a bare array and a BOM', () => {
    expect(parseImport('﻿[{"abbreviation":";a1","text":"x"}]').drafts).toEqual([{ abbreviation: ';a1', text: 'x', label: '' }]);
  });

  it('reports invalid and duplicate entries with their position', () => {
    const result = parseImport(
      JSON.stringify({
        snippets: [
          { abbreviation: ';ok', text: 'fine' },
          { abbreviation: 'has space', text: 'x' },
          { abbreviation: ';ok', text: 'again' },
          'nope',
          { abbreviation: ';empty', text: '' },
        ],
      }),
    );
    expect(result.drafts.map((draft) => draft.abbreviation)).toEqual([';ok']);
    expect(result.skipped).toEqual([
      { position: 2, abbreviation: 'has space', reason: "Abbreviations can't contain spaces or line breaks." },
      { position: 3, abbreviation: ';ok', reason: 'Duplicate abbreviation in this file.' },
      { position: 4, abbreviation: '', reason: 'Not a snippet object.' },
      { position: 5, abbreviation: ';empty', reason: 'Enter the text to insert.' },
    ]);
  });

  it('rejects unusable files with a clear message', () => {
    expect(() => parseImport('{oops')).toThrow("This file isn't valid JSON.");
    expect(() => parseImport('{"foo": 1}')).toThrow(/No snippets found/);
    expect(() => parseImport('[]')).toThrow('This file contains no snippets.');
    expect(() => parseImport('[{"abbreviation":"x y","text":"z"}]')).toThrow('None of the 1 entries is a valid snippet.');
    const tooMany = JSON.stringify(Array.from({ length: LIMITS.snippetsMax + 1 }, (_, i) => ({ abbreviation: `;s${i}`, text: 'x' })));
    expect(() => parseImport(tooMany)).toThrow(/limit/);
    expect(() => parseImport(' '.repeat(6 * 1024 * 1024))).toThrow(/too large/);
    try {
      parseImport('nope');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
    }
  });
});

describe('planImport', () => {
  const existing = [snippet(';ty', 'Thanks'), snippet(';sig', 'Old signature'), snippet(';same', 'same', 'Same')];
  const drafts = [
    { abbreviation: ';sig', text: 'New signature', label: 'Signature' },
    { abbreviation: ';same', text: 'same', label: 'Same' },
    { abbreviation: ';new', text: 'Fresh', label: '' },
  ];

  it('merges: adds new, updates changed, keeps the rest and their ids', () => {
    const plan = planImport(existing, drafts, 'merge', createId, 99);
    expect({ added: plan.added, updated: plan.updated, unchanged: plan.unchanged, removed: plan.removed }).toEqual({ added: 1, updated: 1, unchanged: 1, removed: 0 });
    expect(plan.snippets.map((entry) => [entry.abbreviation, entry.text])).toEqual([
      [';ty', 'Thanks'],
      [';sig', 'New signature'],
      [';same', 'same'],
      [';new', 'Fresh'],
    ]);
    expect(plan.snippets[1]).toMatchObject({ id: 'id;sig', label: 'Signature', createdAt: 1, updatedAt: 99 });
    expect(plan.snippets[3]).toMatchObject({ createdAt: 99, updatedAt: 99 });
  });

  it('replaces everything', () => {
    const plan = planImport(existing, drafts, 'replace', createId, 99);
    expect(plan.snippets.map((entry) => entry.abbreviation)).toEqual([';sig', ';same', ';new']);
    expect(plan.removed).toBe(3);
    expect(plan.added).toBe(3);
  });

  it('refuses to exceed the snippet limit when merging', () => {
    const full = Array.from({ length: LIMITS.snippetsMax }, (_, i) => snippet(`;s${i}`));
    expect(() => planImport(full, [{ abbreviation: ';extra', text: 'x', label: '' }], 'merge', createId, 1)).toThrow(/limit/);
  });
});
