// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import brokenHtml from '../e2e/fixtures/chatgpt-broken.html?raw';
import homeHtml from '../e2e/fixtures/chatgpt-home.html?raw';
import streamingHtml from '../e2e/fixtures/chatgpt-streaming.html?raw';
import chatgptHtml from '../e2e/fixtures/chatgpt.html?raw';
import claudeHtml from '../e2e/fixtures/claude.html?raw';
import { readConversation, ReadError } from '../src/core/read';
import { adapterFor } from '../src/sites';
import { chatgpt } from '../src/sites/chatgpt';
import { claude } from '../src/sites/claude';

/** The e2e fixture pages double as unit-test input: same DOM assumptions, no browser needed. */
const FIXTURES: Record<string, string> = {
  'chatgpt.html': chatgptHtml,
  'chatgpt-streaming.html': streamingHtml,
  'chatgpt-broken.html': brokenHtml,
  'chatgpt-home.html': homeHtml,
  'claude.html': claudeHtml,
};

function fixture(name: string): Document {
  return new DOMParser().parseFromString(FIXTURES[name] ?? '', 'text/html');
}

const CHATGPT_URL = 'https://chatgpt.com/c/6710aa01-1111-4000-8000-000000000001';
const CLAUDE_URL = 'https://claude.ai/chat/0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c';

function readError(fn: () => unknown): ReadError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReadError) return error;
    throw error;
  }
  throw new Error('expected a ReadError');
}

describe('adapter selection and conversation ids', () => {
  it('picks the adapter by host', () => {
    expect(adapterFor(new URL('https://chatgpt.com/c/abc12345'))?.id).toBe('chatgpt');
    expect(adapterFor(new URL('https://chat.openai.com/c/abc12345'))?.id).toBe('chatgpt');
    expect(adapterFor(new URL('https://claude.ai/chat/abc12345'))?.id).toBe('claude');
    expect(adapterFor(new URL('https://example.com/c/abc12345'))).toBeNull();
    // Only the chat hosts: a local server or a look-alike host is never recognised.
    expect(adapterFor(new URL('http://127.0.0.1:8080/chatgpt/c/abc12345'))).toBeNull();
    expect(adapterFor(new URL('https://chatgpt.com.example.net/c/abc12345'))).toBeNull();
  });

  it('reads ChatGPT conversation ids from normal, GPT, project and shared URLs', () => {
    const id = (path: string) => chatgpt.getConversationId(new URL(`https://chatgpt.com${path}`));
    expect(id('/c/6710aa01-1111-4000-8000-000000000001')).toBe('6710aa01-1111-4000-8000-000000000001');
    expect(id('/g/g-abc123-writer/c/6710aa01-1111')).toBe('6710aa01-1111');
    expect(id('/g/g-p-67f0/project/c/6710aa01-2222')).toBe('6710aa01-2222');
    expect(id('/share/67f0aa01-3333')).toBe('share-67f0aa01-3333');
    expect(id('/')).toBeNull();
    expect(id('/gpts')).toBeNull();
  });

  it('reads Claude conversation ids', () => {
    const id = (path: string) => claude.getConversationId(new URL(`https://claude.ai${path}`));
    expect(id('/chat/0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c')).toBe('0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c');
    expect(id('/share/0f3c2a9e-aaaa')).toBe('share-0f3c2a9e-aaaa');
    expect(id('/new')).toBeNull();
    expect(id('/recents')).toBeNull();
  });
});

describe('ChatGPT adapter on the fixture page', () => {
  const doc = fixture('chatgpt.html');
  const conversation = readConversation(chatgpt, doc, `${CHATGPT_URL}?model=gpt-5#top`);

  it('reads title, URL, id and roles', () => {
    expect(conversation.title).toBe('Sorting in Python');
    expect(conversation.url).toBe(CHATGPT_URL);
    expect(conversation.conversationId).toBe('6710aa01-1111-4000-8000-000000000001');
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conversation.streaming).toBe(false);
  });

  it('converts the user message with its image and line break', () => {
    expect(conversation.messages[0]?.markdown).toBe(
      "[Image: Uploaded image](https://chatgpt.com/files/screenshot.png)\n\nHow do I sort a list of dicts by a key in Python?  \nAlso: what's the complexity? I tried \\`sorted(data)\\` and got a \\*TypeError\\*.",
    );
    expect(conversation.messages[0]?.text).toContain("Also: what's the complexity? I tried `sorted(data)` and got a *TypeError*.");
  });

  it('converts the rich assistant reply', () => {
    const markdown = conversation.messages[1]?.markdown ?? '';
    expect(markdown).toContain('Use `sorted()` with a **key function**.');
    expect(markdown).toContain(
      '```python\nfrom operator import itemgetter\n\npeople = [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 28}]\nby_age = sorted(people, key=itemgetter("age"))\nby_name_desc = sorted(people, key=lambda p: p["name"], reverse=True)\n```',
    );
    expect(markdown).toContain('### Complexity');
    expect(markdown).toContain('Python uses Timsort: $O(n \\log n)$ comparisons in the worst case and $O(n)$ on already sorted data.');
    expect(markdown).toContain('$$\nT(n) = \\sum_{i=1}^{\\log_2 n} n = n \\log_2 n\n$$');
    expect(markdown).toContain('| Option | Stable | Notes |\n| --- | --- | --- |\n| `sorted()` | Yes | Returns a new list |\n| `list.sort()` | Yes | Sorts in place, returns `None` |');
    expect(markdown).toContain('- Sort by several keys:\n  - `key=itemgetter("age", "name")`\n  - or a tuple in a lambda\n- Missing keys: use `d.get("age", 0)`');
    expect(markdown).toContain('1. Pick the key\n2. Decide the order');
    expect(markdown).toContain('> Tip: `reverse=True` keeps the sort stable.');
    expect(markdown).toContain('Docs: [Sorting HOW TO](https://docs.python.org/3/howto/sorting.html)');
  });

  it('drops UI chrome', () => {
    const everything = conversation.messages.map((message) => `${message.markdown}\n${message.text}`).join('\n');
    for (const chrome of ['Copy code', 'Copy table', 'ChatGPT said', 'You said', 'Read aloud', 'Edit']) expect(everything).not.toContain(chrome);
  });

  it('escapes markup typed by the user', () => {
    expect(conversation.messages[2]?.markdown).toBe('Thanks! Does this work for \\<script>alert("x")\\</script> strings and 5 \\* 3 = 15? snake_case_names too.');
    expect(conversation.messages[3]?.markdown).toContain('[Image: Sorting benchmark chart](https://chatgpt.com/files/chart.png)');
  });

  it('finds the header spot for the button', () => {
    const target = chatgpt.injectButtonTarget(doc);
    expect(target?.element.id).toBe('conversation-header-actions');
    expect(target?.position).toBe('prepend');
  });

  it('falls back to the sidebar for the title', () => {
    const untitled = fixture('chatgpt.html');
    untitled.title = 'ChatGPT';
    expect(chatgpt.getConversationTitle(untitled, new URL(CHATGPT_URL))).toBe('Sorting in Python');
  });
});

describe('ChatGPT adapter: streaming, changed layout, no conversation', () => {
  it('marks a reply that is still being written', () => {
    const doc = fixture('chatgpt-streaming.html');
    expect(chatgpt.isStreaming(doc)).toBe(true);
    const conversation = readConversation(chatgpt, doc, 'https://chatgpt.com/c/stream-0001-aaaa');
    expect(conversation.streaming).toBe(true);
    expect(conversation.messages[1]?.incomplete).toBe(true);
    expect(conversation.messages[1]?.markdown).toBe('Here is a pattern for ISO dates:');
  });

  it('fails loudly when the expected structure is missing', () => {
    const error = readError(() => readConversation(chatgpt, fixture('chatgpt-broken.html'), 'https://chatgpt.com/c/broken-0001-aaaa'));
    expect(error.code).toBe('SITE_CHANGED');
    expect(error.message).toBe("Couldn't read this conversation, the site may have changed.");
  });

  it('fails loudly when only one side of the conversation is found', () => {
    const doc = fixture('chatgpt.html');
    for (const element of Array.from(doc.querySelectorAll('[data-message-author-role="assistant"]'))) element.removeAttribute('data-message-author-role');
    expect(readError(() => readConversation(chatgpt, doc, CHATGPT_URL)).code).toBe('SITE_CHANGED');
  });

  it('says there is no conversation on the home page', () => {
    expect(readError(() => readConversation(chatgpt, fixture('chatgpt-home.html'), 'https://chatgpt.com/')).code).toBe('NOT_CONVERSATION');
  });
});

describe('Claude adapter on the fixture page', () => {
  const doc = fixture('claude.html');
  const conversation = readConversation(claude, doc, CLAUDE_URL);

  it('reads title and roles', () => {
    expect(conversation.title).toBe('Rust ownership basics');
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps user paragraphs', () => {
    expect(conversation.messages[0]?.markdown).toBe('Explain Rust ownership with a short example.\n\nKeep it brief, please. Привіт, café!');
  });

  it('converts code with the language label, lists, math and tables', () => {
    const markdown = conversation.messages[1]?.markdown ?? '';
    expect(markdown).toContain(
      '```rust\nfn main() {\n    let s1 = String::from("hi");\n    let s2 = s1; // s1 is moved\n    println!("{}", s2);\n}\n```',
    );
    expect(markdown).not.toMatch(/^rust$/m);
    expect(markdown).toContain('1. Each value has one owner.\n2. Assignment *moves* ownership.\n3. Borrowing (`&s`) lends access without moving.');
    expect(markdown).toContain('A move costs $O(1)$: only the pointer, length and capacity are copied.');
    expect(markdown).toContain('$$\n\\text{size}(String) = 3 \\times 8 \\text{ bytes}\n$$');
    expect(markdown).toContain('| `String` | No |');
    expect(markdown).toContain('> The borrow checker enforces these rules at compile time.');
    expect(markdown).not.toContain('Copy to clipboard');
    expect(markdown).not.toMatch(/^Copy$/m);
    expect(markdown).not.toContain('Retry');
  });

  it('uses the floating button (no header spot in this layout)', () => {
    expect(claude.injectButtonTarget(doc)).toBeNull();
    expect(claude.isStreaming(doc)).toBe(false);
  });

  it('marks a streaming Claude reply', () => {
    const streaming = fixture('claude.html');
    streaming.querySelectorAll('[data-is-streaming]')[1]?.setAttribute('data-is-streaming', 'true');
    const result = readConversation(claude, streaming, CLAUDE_URL);
    expect(result.streaming).toBe(true);
    expect(result.messages[3]?.incomplete).toBe(true);
    expect(result.messages[1]?.incomplete).toBeUndefined();
  });
});

describe('leaving out code blocks', () => {
  it('replaces code blocks (and their language labels) with a note, in Markdown and text', () => {
    const conversation = readConversation(claude, fixture('claude.html'), CLAUDE_URL, { omitCode: true });
    const all = conversation.messages.map((message) => message.markdown).join('\n');
    expect(all).not.toContain('```');
    expect(all).not.toContain('fn main()');
    expect(all).toContain('*(Code block omitted.)*');
    expect(all).not.toMatch(/^rust$/m);
    const text = conversation.messages.map((message) => message.text).join('\n');
    expect(text).toContain('(Code block omitted.)');
    expect(text).not.toContain('fn main()');
    // Inline code and math stay.
    expect(all).toContain('$O(1)$');
  });

  it('keeps code by default', () => {
    const chat = readConversation(chatgpt, fixture('chatgpt.html'), CHATGPT_URL);
    expect(chat.messages[1]?.markdown).toContain('```python');
    const omitted = readConversation(chatgpt, fixture('chatgpt.html'), CHATGPT_URL, { omitCode: true });
    expect(omitted.messages[1]?.markdown).not.toContain('```python');
    expect(omitted.messages[1]?.markdown).toContain('`sorted()`');
    expect(omitted.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('selected messages', () => {
  it('keeps only the selected messages, in page order', () => {
    const conversation = readConversation(chatgpt, fixture('chatgpt.html'), CHATGPT_URL, { selected: new Set([3, 1]) });
    expect(conversation.messages.map((message) => message.role)).toEqual(['assistant', 'assistant']);
    expect(conversation.messages[0]?.markdown).toContain('Use `sorted()` with a **key function**.');
    expect(conversation.title).toBe('Sorting in Python');
  });

  it('keeps a turn rendered in several blocks whole when one block is selected', () => {
    const doc = fixture('chatgpt.html');
    // Split the first reply in two blocks, as around a tool call.
    const reply = doc.querySelector('[data-message-id="m-2"]');
    const extra = doc.createElement('div');
    extra.setAttribute('data-message-author-role', 'assistant');
    extra.innerHTML = '<div class="markdown"><p>Second block of the same turn.</p></div>';
    reply?.after(extra);
    expect(chatgpt.getMessages(doc)).toHaveLength(5);
    const conversation = readConversation(chatgpt, doc, CHATGPT_URL, { selected: new Set([2]) });
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.markdown).toMatch(/key function[\s\S]*Second block of the same turn\.$/);
  });

  it('still refuses a page it cannot read, and a selection without the streaming reply is complete', () => {
    expect(readError(() => readConversation(chatgpt, fixture('chatgpt-broken.html'), 'https://chatgpt.com/c/broken-0001-aaaa', { selected: new Set([0]) })).code).toBe('SITE_CHANGED');
    const streaming = readConversation(chatgpt, fixture('chatgpt-streaming.html'), 'https://chatgpt.com/c/stream-0001-aaaa', { selected: new Set([0]) });
    expect(streaming.streaming).toBe(false);
    expect(streaming.messages.map((message) => message.role)).toEqual(['user']);
  });
});
