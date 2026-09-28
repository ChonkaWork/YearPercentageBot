import { describe, expect, it } from 'vitest';
import { buildExport, parseImport, planImport, ImportLimitError } from '../src/core/importExport';
import {
  allTags,
  clipTags,
  filterByTag,
  formatTags,
  normalizeDraft,
  normalizeTags,
  sanitizeSnippets,
  searchSnippets,
  validateFields,
  type Snippet,
} from '../src/core/snippets';

const snippet = (abbreviation: string, tags?: string[], text = 'text'): Snippet => ({
  id: `id${abbreviation}`,
  abbreviation,
  text,
  label: '',
  ...(tags ? { tags } : {}),
  createdAt: 1,
  updatedAt: 1,
});

let counter = 0;
const createId = () => `new${++counter}`;

describe('tags', () => {
  it('normalizes comma-separated text and lists', () => {
    expect(normalizeTags(' work,  Sales team ,#replies, WORK,, ')).toEqual(['work', 'Sales team', 'replies']);
    expect(normalizeTags(['a', 3, 'b,c', ' '])).toEqual(['a', 'b c']);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(formatTags(['work', 'sales'])).toBe('work, sales');
  });

  it('are omitted from drafts when empty, so older data and exports stay the same', () => {
    expect(normalizeDraft({ abbreviation: ';a', text: 'x', tags: '' })).toEqual({ abbreviation: ';a', text: 'x', label: '' });
    expect(normalizeDraft({ abbreviation: ';a', text: 'x', tags: 'b, a' })).toEqual({ abbreviation: ';a', text: 'x', label: '', tags: ['b', 'a'] });
  });

  it('validates length and count in the editor', () => {
    expect(validateFields(normalizeDraft({ abbreviation: ';a', text: 'x', tags: 'x'.repeat(25) })).tags).toMatch(/too long/);
    expect(validateFields(normalizeDraft({ abbreviation: ';a', text: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).tags).toMatch(/at most 10/);
    expect(validateFields(normalizeDraft({ abbreviation: ';a', text: 'x', tags: 'ok' }))).toEqual({});
  });

  it('bad tags in storage are dropped without losing the snippet', () => {
    const [stored] = sanitizeSnippets([{ id: 'a', abbreviation: ';a', text: 'x', tags: ['ok', 'y'.repeat(30), 7, 'OK'] }]);
    expect(stored?.tags).toEqual(['ok']);
    const [none] = sanitizeSnippets([{ id: 'b', abbreviation: ';b', text: 'x', tags: 'nope-not-a-list' }]);
    expect(none?.tags).toEqual(['nope-not-a-list']);
    expect(clipTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });

  it('counts tags case-insensitively and filters by them', () => {
    const list = [snippet(';a', ['Work']), snippet(';b', ['work', 'sales']), snippet(';c')];
    expect(allTags(list)).toEqual([
      { tag: 'sales', count: 1 },
      { tag: 'Work', count: 2 },
    ]);
    expect(filterByTag(list, 'WORK').map((entry) => entry.abbreviation)).toEqual([';a', ';b']);
    expect(filterByTag(list, null)).toHaveLength(3);
    expect(searchSnippets(list, 'sales').map((entry) => entry.abbreviation)).toEqual([';b']);
  });

  it('round-trip through export and import', () => {
    const json = buildExport([snippet(';a', ['work']), snippet(';b')], new Date());
    const file = JSON.parse(json);
    expect(file.snippets).toEqual([
      { abbreviation: ';a', text: 'text', label: '', tags: ['work'] },
      { abbreviation: ';b', text: 'text', label: '' },
    ]);
    expect(parseImport(json).drafts).toEqual(file.snippets);
    // A bad tag in a file costs only the tag.
    expect(parseImport(JSON.stringify([{ abbreviation: ';x', text: 'y', tags: ['z'.repeat(40), 'fine'] }])).drafts).toEqual([
      { abbreviation: ';x', text: 'y', label: '', tags: ['fine'] },
    ]);
  });

  it('merge keeps tags when the file has none and takes them when it has some', () => {
    const existing = [snippet(';a', ['work'], 'old'), snippet(';b', ['home'])];
    const plan = planImport(existing, [{ abbreviation: ';a', text: 'new', label: '' }, { abbreviation: ';b', text: 'text', label: '', tags: ['family'] }], 'merge', createId, 5);
    expect(plan.snippets.map((entry) => [entry.abbreviation, entry.text, entry.tags])).toEqual([
      [';a', 'new', ['work']],
      [';b', 'text', ['family']],
    ]);
    expect(plan.updated).toBe(2);
    expect(planImport(existing, [{ abbreviation: ';b', text: 'text', label: '' }], 'merge', createId, 5).unchanged).toBe(1);
  });

  it('without the tags feature, imported tags are dropped and existing ones kept', () => {
    const existing = [snippet(';a', ['work'], 'old')];
    const drafts = [
      { abbreviation: ';a', text: 'new', label: '', tags: ['other'] },
      { abbreviation: ';n', text: 'x', label: '', tags: ['t'] },
    ];
    const plan = planImport(existing, drafts, 'merge', createId, 5, { tags: false });
    expect(plan.snippets.map((entry) => [entry.abbreviation, entry.tags])).toEqual([
      [';a', ['work']],
      [';n', undefined],
    ]);
  });
});

describe('import against the plan limit', () => {
  const many = (count: number, prefix = ';s') => Array.from({ length: count }, (_, i) => snippet(`${prefix}${i}`));

  it('blocks adding past the free limit, but updates always work', () => {
    const existing = many(18);
    const drafts = many(3, ';n').map(({ abbreviation, text, label }) => ({ abbreviation, text, label }));
    expect(() => planImport(existing, drafts, 'merge', createId, 1, { maxSnippets: 20 })).toThrow(ImportLimitError);
    expect(planImport(existing, drafts.slice(0, 2), 'merge', createId, 1, { maxSnippets: 20 }).added).toBe(2);
    // Over the limit already (e.g. after a downgrade): updating existing snippets is fine.
    const over = many(25);
    const updates = [{ abbreviation: ';s1', text: 'changed', label: '' }];
    expect(planImport(over, updates, 'merge', createId, 1, { maxSnippets: 20 }).updated).toBe(1);
    try {
      planImport(existing, drafts, 'replace', createId, 1, { maxSnippets: 2 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportLimitError);
      expect((error as ImportLimitError).total).toBe(3);
      expect((error as ImportLimitError).max).toBe(2);
    }
  });
});
