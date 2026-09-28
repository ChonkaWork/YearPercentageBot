import { describe, expect, it } from 'vitest';
import { buildHandoff, compactTokens, describeSize, estimateTokens, HANDOFF_RECENT, shortenMessage } from '../src/core/handoff';
import type { Conversation, Message } from '../src/core/types';

const user = (markdown: string): Message => ({ role: 'user', markdown, text: markdown });
const reply = (markdown: string): Message => ({ role: 'assistant', markdown, text: markdown });

function conversation(messages: Message[], site: Conversation['site'] = 'chatgpt'): Conversation {
  return { site, conversationId: 'c1', title: 'Sorting  in Python', url: 'https://chatgpt.com/c/c1', streaming: false, messages };
}

describe('hand-off prompt', () => {
  it('puts a short conversation in full, with the instruction first', () => {
    const handoff = buildHandoff(conversation([user('How do I sort?'), reply('Use `sorted()`.')]));
    expect(handoff.text).toBe(
      [
        'Here is our earlier conversation from ChatGPT. Continue from where it ends.',
        '',
        'Title: Sorting in Python',
        '',
        '<conversation>',
        '[User]',
        'How do I sort?',
        '',
        '[ChatGPT]',
        'Use `sorted()`.',
        '</conversation>',
        '',
      ].join('\n'),
    );
    expect(handoff).toMatchObject({ full: 2, shortened: 0, characters: handoff.text.length });
  });

  it('keeps the last messages in full and shortens older ones to their first lines, keeping code', () => {
    const older = reply('Use a key function.\nIt returns a new list.\nA third line that is dropped.\n\n```python\nsorted(people, key=itemgetter("age"))\n```\n\nMore prose after the code.');
    const messages = [user('First question'), older, ...Array.from({ length: HANDOFF_RECENT }, (_, index) => (index % 2 ? reply(`Answer ${index}`) : user(`Question ${index}`)))];
    const handoff = buildHandoff(conversation(messages, 'claude'));
    expect(handoff).toMatchObject({ full: 6, shortened: 2 });
    expect(handoff.text).toContain('Here is our earlier conversation from Claude. Continue from where it ends.');
    expect(handoff.text).toContain('The first 2 messages are shortened to their first lines (code is kept); the last 6 messages are complete.');
    expect(handoff.text).toContain('[User, shortened]\nFirst question\n\n[Claude, shortened]\nUse a key function.\nIt returns a new list. …\n\n```python\nsorted(people, key=itemgetter("age"))\n```\n\n[User]\nQuestion 0');
    expect(handoff.text).not.toContain('third line');
    expect(handoff.text.endsWith('[Claude]\nAnswer 5\n</conversation>\n')).toBe(true);
  });

  it('marks a reply that was cut off', () => {
    const handoff = buildHandoff(conversation([user('Hi'), { ...reply('Partial answ'), incomplete: true }]));
    expect(handoff.text).toContain('[ChatGPT, cut off]\nPartial answ');
  });

  it('can include fewer recent messages', () => {
    const handoff = buildHandoff(conversation([user('a'), reply('b'), user('c')]), 1);
    expect(handoff).toMatchObject({ full: 1, shortened: 2 });
    expect(handoff.text).toContain('The first 2 messages are shortened to their first lines (code is kept); the last 1 message is complete.');
  });
});

describe('shortenMessage', () => {
  it('cuts long first lines at a word and keeps unclosed code', () => {
    const long = `${'word '.repeat(80)}end`;
    const short = shortenMessage(`${long}\n~~~\ncode without end`);
    expect(short.startsWith('word word')).toBe(true);
    expect(short.split('\n\n')[0]?.length).toBeLessThanOrEqual(242);
    expect(short).toMatch(/word …\n\n~~~\ncode without end$/);
  });

  it('keeps only code when there is no prose, and says when a message is empty', () => {
    expect(shortenMessage('```js\nx()\n```')).toBe('```js\nx()\n```');
    expect(shortenMessage('   ')).toBe('(empty)');
  });
});

describe('token estimate', () => {
  it('is about 4 characters per token for English and 2 for other scripts', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
    expect(estimateTokens('ї'.repeat(100))).toBe(50);
  });

  it('formats sizes for the menu and the messages', () => {
    expect(describeSize({ characters: 4210, tokens: 1050 })).toBe('4,210 characters · ≈1,050 tokens');
    expect(compactTokens(850)).toBe('≈850 tokens');
    expect(compactTokens(1234)).toBe('≈1.2k tokens');
    expect(compactTokens(2000)).toBe('≈2k tokens');
    expect(compactTokens(36_400)).toBe('≈36k tokens');
  });
});
