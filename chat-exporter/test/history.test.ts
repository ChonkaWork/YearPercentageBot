import { describe, expect, it } from 'vitest';
import chatgptExport from '../e2e/fixtures/chatgpt-export.json?raw';
import claudeExport from '../e2e/fixtures/claude-export.json?raw';
import { importHistory, type ImportedConversation } from '../src/core/import';
import { openZipEntry, readZipDirectory } from '../src/core/import/zip';
import { formatDate, formatLocalIso } from '../src/export/labels';
import { HistoryArchive, historyIndex, historyZipName, toConversation, UniqueNames, type HistoryEntry } from '../src/export/history';
import { DEFAULT_EXPORT_OPTIONS, sanitizeExportOptions } from '../src/export/options';

const now = new Date(2026, 8, 28, 14, 3, 9);

/** Imports a fixture export into a history zip and reads every file back. */
async function convert(json: string, format: 'obsidian' | 'markdown', exportOptions = DEFAULT_EXPORT_OPTIONS) {
  const archive = new HistoryArchive({ format, exportOptions, now });
  const summary = await importHistory(new Blob([json]), { onConversation: (conversation) => archive.add(conversation).then(() => undefined) });
  const zip = new Blob((await archive.finish(summary)) as BlobPart[]);
  const files = new Map<string, string>();
  for (const entry of await readZipDirectory(zip)) files.set(entry.name, await new Response((await openZipEntry(zip, entry)).stream).text());
  return { files, summary, archive };
}

const local = (iso: string) => formatLocalIso(new Date(iso));
const day = (iso: string) => formatDate(new Date(iso));

describe('history archive (ChatGPT)', () => {
  it('writes one Markdown file per conversation, named from the template and the conversation date, plus index.md', async () => {
    const { files } = await convert(chatgptExport, 'obsidian');
    expect([...files.keys()]).toEqual([
      `Sorting in Python ${day('2026-09-27T10:02:03Z')}.md`,
      `Trip to Lviv ${day('2026-08-14T18:20:00Z')}.md`,
      `Regex for ISO dates like 2026-09-27 ${day('2026-03-02T09:00:00Z')}.md`,
      `Sorting in Python ${day('2026-09-27T16:40:00Z')} (2).md`,
      'index.md',
    ]);
  });

  it('puts the original dates in the Obsidian front matter', async () => {
    const { files } = await convert(chatgptExport, 'obsidian');
    const note = files.get(`Sorting in Python ${day('2026-09-27T10:02:03Z')}.md`) ?? '';
    expect(note.startsWith(
      [
        '---',
        'title: "Sorting in Python"',
        'source: "ChatGPT"',
        'url: "https://chatgpt.com/c/6710aa01-1111-4000-8000-000000000001"',
        `date: ${day('2026-09-27T10:02:03Z')}`,
        `created: ${local('2026-09-27T10:02:03Z')}`,
        `updated: ${local('2026-09-27T10:09:41Z')}`,
        'tags:',
        '  - "ai-chat"',
        '  - "chatgpt"',
        '---',
        '',
        '## You',
        '',
        'How do I sort a list of dicts by a key in Python?  ',
        'I tried \\`sorted(data)\\` and got a \\*TypeError\\*.',
        '',
        '## ChatGPT',
        '',
        'Use `sorted()` with a **key function**.',
      ].join('\n'),
    ), note.slice(0, 600)).toBe(true);
    // Reply headings are shifted below the role headings; code stays; typed markup is escaped.
    expect(note).toContain('#### Complexity');
    expect(note).toContain('```python\nfrom operator import itemgetter\n');
    expect(note).toContain('\\[image\\]\n\nHere is my benchmark. Does \\<script>alert("x")\\</script> sort before letters?');
    expect(note).not.toContain('OLD BRANCH');
  });

  it('uses the tags, callouts and file name template from the export options', async () => {
    const options = sanitizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, filenameTemplate: '{site} - {date} - {title}', tags: ['archive'], callouts: true });
    const { files } = await convert(chatgptExport, 'obsidian', options);
    const name = `ChatGPT - ${day('2026-08-14T18:20:00Z')} - Trip to Lviv.md`;
    const note = files.get(name) ?? '';
    expect(note).toContain('tags:\n  - "archive"\n  - "chatgpt"\n---');
    expect(note).toContain('> [!question] You\n> Сплануй поїздку до Львова на вихідні. Бюджет — 5000 грн.');
    expect(note).toContain('> [!note] ChatGPT\n> ```python\n> budget = 5000');
  });

  it('plain Markdown keeps the metadata list with the original dates', async () => {
    const { files } = await convert(chatgptExport, 'markdown');
    const note = files.get(`Trip to Lviv ${day('2026-08-14T18:20:00Z')}.md`) ?? '';
    expect(note.split('\n').slice(0, 9)).toEqual([
      '# Trip to Lviv',
      '',
      '- Source: ChatGPT',
      '- URL: <https://chatgpt.com/c/6710aa02-2222-4000-8000-000000000002>',
      `- Created: ${local('2026-08-14T18:20:00Z').replace('T', ' ')}`,
      `- Updated: ${local('2026-08-14T18:24:30Z').replace('T', ' ')}`,
      '- Exported: 2026-09-28 14:03',
      '- Messages: 2',
      '',
    ]);
  });

  it('writes an index of every conversation, newest first, grouped by month', async () => {
    const { files } = await convert(chatgptExport, 'obsidian');
    const index = files.get('index.md') ?? '';
    const link = (name: string) => encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
    expect(index).toBe(
      [
        '# ChatGPT history',
        '',
        '- Conversations: 4',
        '- Messages: 10',
        '- Imported: 2026-09-28 14:03 from `conversations.json`',
        '',
        `## ${day('2026-09-27T16:40:00Z').slice(0, 7)}`,
        '',
        `- ${day('2026-09-27T16:40:00Z')} · [Sorting in Python](${link(`Sorting in Python ${day('2026-09-27T16:40:00Z')} (2).md`)}) · 2 messages`,
        `- ${day('2026-09-27T10:02:03Z')} · [Sorting in Python](${link(`Sorting in Python ${day('2026-09-27T10:02:03Z')}.md`)}) · 4 messages`,
        '',
        `## ${day('2026-08-14T18:20:00Z').slice(0, 7)}`,
        '',
        `- ${day('2026-08-14T18:20:00Z')} · [Trip to Lviv](${link(`Trip to Lviv ${day('2026-08-14T18:20:00Z')}.md`)}) · 2 messages`,
        '',
        `## ${day('2026-03-02T09:00:00Z').slice(0, 7)}`,
        '',
        `- ${day('2026-03-02T09:00:00Z')} · [Regex for ISO dates like 2026-09-27?](${link(`Regex for ISO dates like 2026-09-27 ${day('2026-03-02T09:00:00Z')}.md`)}) · 2 messages`,
        '',
      ].join('\n'),
    );
  });
});

describe('history archive (Claude)', () => {
  it('converts the Claude export with its dates and attachments', async () => {
    const { files, summary } = await convert(claudeExport, 'obsidian');
    expect(summary.sources).toEqual(['claude']);
    const note = files.get(`Rust ownership basics ${day('2026-09-20T07:15:00Z')}.md`) ?? '';
    expect(note).toContain('url: "https://claude.ai/chat/0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c"');
    expect(note).toContain(`created: ${local('2026-09-20T07:15:00Z')}`);
    expect(note).toContain('## Claude\n\nEvery value has **one owner**.');
    expect(note).toContain('\\[File: main.rs\\]\n\n\\[File: error.png\\]\n\nWhy does this fail to compile?');
    expect(files.get('index.md')).toMatch(/^# Claude history\n/);
  });
});

describe('history helpers', () => {
  it('makes names unique without regard to case', () => {
    const names = new UniqueNames(['index.md']);
    expect(names.claim('Index.md')).toBe('Index (2).md');
    expect(names.claim('Notes.md')).toBe('Notes.md');
    expect(names.claim('notes.md')).toBe('notes (2).md');
    expect(names.claim('NOTES.md')).toBe('NOTES (3).md');
    // A title that already looks like a suffixed name doesn't collide either.
    expect(names.claim('Notes (4).md')).toBe('Notes (4).md');
    expect(names.claim('Notes.md')).toBe('Notes (5).md');
  });

  it('stays fast with thousands of conversations of the same title', () => {
    const names = new UniqueNames();
    const started = performance.now();
    for (let index = 0; index < 20000; index++) names.claim('New chat 2026-09-28.md');
    expect(names.claim('New chat 2026-09-28.md')).toBe('New chat 2026-09-28 (20001).md');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('escapes what the user typed and keeps replies as Markdown', () => {
    const imported: ImportedConversation = {
      source: 'chatgpt',
      id: '',
      title: 't',
      url: '',
      createdAt: null,
      updatedAt: null,
      messages: [
        { role: 'user', format: 'text', content: '# not a heading\n2 * 3 = 6', createdAt: null },
        { role: 'assistant', format: 'markdown', content: '**bold**', createdAt: null },
      ],
    };
    expect(toConversation(imported)).toEqual({
      site: 'chatgpt',
      conversationId: null,
      title: 't',
      url: '',
      streaming: false,
      messages: [
        { role: 'user', markdown: '\\# not a heading  \n2 \\* 3 = 6', text: '# not a heading\n2 * 3 = 6' },
        { role: 'assistant', markdown: '**bold**', text: '**bold**' },
      ],
    });
  });

  it('lists undated conversations last and names the source when there are several', () => {
    const entries: HistoryEntry[] = [
      { file: 'a.md', title: 'No date', source: 'claude', date: null, messages: 1 },
      { file: 'b [x].md', title: 'Dated *one*', source: 'chatgpt', date: new Date(2025, 0, 5), messages: 3 },
    ];
    expect(historyIndex(entries, { sources: ['chatgpt', 'claude'], path: 'x/conversations.json' }, now)).toBe(
      [
        '# Chat history',
        '',
        '- Conversations: 2',
        '- Messages: 4',
        '- Imported: 2026-09-28 14:03 from `x/conversations.json`',
        '',
        '## 2025-01',
        '',
        '- 2025-01-05 · [Dated \\*one\\*](b%20%5Bx%5D.md) · ChatGPT · 3 messages',
        '',
        '## Undated',
        '',
        '- [No date](a.md) · Claude · 1 message',
        '',
      ].join('\n'),
    );
  });

  it('names the zip after the source and the day', () => {
    expect(historyZipName(['chatgpt'], now)).toBe('ChatGPT history 2026-09-28.zip');
    expect(historyZipName(['claude'], now)).toBe('Claude history 2026-09-28.zip');
    expect(historyZipName(['chatgpt', 'claude'], now)).toBe('Chat history 2026-09-28.zip');
  });
});
