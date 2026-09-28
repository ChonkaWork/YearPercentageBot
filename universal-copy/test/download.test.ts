import { describe, expect, it } from 'vitest';
import { downloadFile, safeFileName } from '../src/core/download';

describe('download files', () => {
  it('names files after the page or table, safely on every OS', () => {
    expect(safeFileName('Shipping a Chrome extension in 2026', 'md')).toBe('Shipping a Chrome extension in 2026.md');
    expect(safeFileName('Q1/Q2: "sales" <draft>?', 'csv')).toBe('Q1 Q2 sales draft.csv');
    expect(safeFileName('Київ — Вікіпедія', 'json')).toBe('Київ — Вікіпедія.json');
    expect(safeFileName('  ..hidden. ', 'md')).toBe('hidden.md');
    expect(safeFileName('a\tb\nc\u{200b}d', 'md')).toBe('a b cd.md');
    expect(safeFileName('', 'csv')).toBe('universal-copy.csv');
    expect(safeFileName(null, 'csv')).toBe('universal-copy.csv');
    expect(safeFileName('///', 'csv')).toBe('universal-copy.csv');
    expect(safeFileName('CON', 'csv')).toBe('universal-copy.csv');
  });

  it('shortens long names without splitting characters', () => {
    const name = safeFileName('😀'.repeat(100), 'md');
    expect([...name.slice(0, -3)]).toHaveLength(80);
    expect(name.endsWith('😀.md')).toBe(true);
  });

  it('sets the type, ends with a line break and adds a BOM to CSV for Excel', () => {
    expect(downloadFile('# Title', 'md', 'Notes')).toEqual({ filename: 'Notes.md', mime: 'text/markdown;charset=utf-8', content: '# Title\n' });
    expect(downloadFile('a,b\n', 'csv', 'Table')).toEqual({ filename: 'Table.csv', mime: 'text/csv;charset=utf-8', content: '\u{feff}a,b\n' });
    expect(downloadFile('[]', 'json', 'Table').mime).toBe('application/json;charset=utf-8');
    expect(downloadFile('[]', 'json', 'Table').content).toBe('[]\n');
  });
});
