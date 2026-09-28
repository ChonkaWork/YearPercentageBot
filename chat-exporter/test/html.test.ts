// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/core/types';
import { buildExportFile } from '../src/export/actions';
import { toHtmlDocument } from '../src/export/html';
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options';

const conversation: Conversation = {
  site: 'chatgpt',
  conversationId: 'abc-123-def',
  title: 'Sorting <b>fast</b> & "well"',
  url: 'https://chatgpt.com/c/abc-123-def',
  streaming: false,
  messages: [
    { role: 'user', markdown: 'Is \\<script>alert(1)\\</script> safe?', text: 'Is <script>alert(1)</script> safe?' },
    { role: 'assistant', markdown: 'Use `sorted()`:\n\n```python\nif a < b:\n    print("<b>")\n```\n\n[docs](javascript:alert(1)) and ![chart](https://x.test/c.png)', text: '' },
  ],
};
const exportedAt = new Date(2026, 8, 27, 14, 3, 9);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('standalone HTML export', () => {
  const html = toHtmlDocument(conversation, exportedAt);
  const doc = parse(html);

  it('is one self-contained file: inline CSS, no scripts, nothing loaded from the network', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(doc.querySelectorAll('script, link, img, iframe, object, embed').length).toBe(0);
    expect(doc.querySelectorAll('style').length).toBe(1);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    // Links (like the image link) are fine: nothing is fetched by opening the file.
    expect(html).not.toMatch(/url\(|@import|\ssrc=|\ssrcset=/);
  });

  it('follows the reader\'s light or dark setting', () => {
    expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('light dark');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('has a header with the title, source, domain, a link to the original and the date', () => {
    expect(doc.title).toBe('Sorting <b>fast</b> & "well"');
    expect(doc.querySelector('h1')?.textContent).toBe('Sorting <b>fast</b> & "well"');
    expect(doc.querySelector('.meta')?.textContent).toBe('ChatGPT · chatgpt.com · Open original · Exported 2026-09-27 14:03 · 2 messages');
    expect(doc.querySelector('.meta a')?.getAttribute('href')).toBe('https://chatgpt.com/c/abc-123-def');
  });

  it('renders messages safely with styled code blocks', () => {
    expect(Array.from(doc.querySelectorAll('.message .role'), (role) => role.textContent)).toEqual(['You', 'ChatGPT']);
    expect(doc.querySelector('.message.user .content')?.textContent).toBe('Is <script>alert(1)</script> safe?');
    expect(doc.querySelector('.code-block .code-language')?.textContent).toBe('python');
    expect(doc.querySelector('pre code.language-python')?.textContent).toBe('if a < b:\n    print("<b>")');
    expect(Array.from(doc.querySelectorAll('.message a'), (link) => link.getAttribute('href'))).toEqual(['https://x.test/c.png']);
    expect(html).not.toContain('javascript:');
  });

  it('works without a URL and notes an unfinished reply', () => {
    const other = parse(toHtmlDocument({ ...conversation, url: '', streaming: true, messages: [{ role: 'assistant', markdown: 'Part', text: 'Part', incomplete: true }] }, exportedAt));
    expect(other.querySelector('.meta')?.textContent).toBe('ChatGPT · Exported 2026-09-27 14:03 · 1 message');
    expect(other.querySelector('.note')?.textContent).toMatch(/still being generated/);
    expect(other.querySelector('.incomplete')?.textContent).toBe('(Incomplete: still being generated.)');
  });

  it('is a download format named from the template', () => {
    const file = buildExportFile('html', conversation, exportedAt, DEFAULT_EXPORT_OPTIONS);
    expect(file).toMatchObject({ filename: 'Sorting b fast b & well 2026-09-27.html', mime: 'text/html' });
    expect(file.content).toBe(html);
  });
});
