import { describe, expect, it } from 'vitest';
import {
  MAX_LINKS,
  MAX_LINK_NAME_LENGTH,
  LinkLimitError,
  addLink,
  createLink,
  hostLabel,
  linkLetter,
  moveLink,
  parseLinkUrl,
  removeLink,
  sanitizeLinks,
  updateLink,
  validateLinkDraft,
  type QuickLink,
} from '../src/core/links';
import { FREE_MAX_LINKS, PRO_MAX_LINKS, limitMessage, listLimit } from '../src/core/plan';

const link = (id: string, name = id, url = `https://${id}.example.com/`): QuickLink => ({ id, name, url });

describe('parseLinkUrl', () => {
  it('accepts http and https, adding https:// to a bare host', () => {
    expect(parseLinkUrl('https://github.com')).toEqual({ ok: true, url: 'https://github.com/' });
    expect(parseLinkUrl('  github.com/ChonkaWork  ')).toEqual({ ok: true, url: 'https://github.com/ChonkaWork' });
    expect(parseLinkUrl('http://intranet/wiki?q=a#b')).toEqual({ ok: true, url: 'http://intranet/wiki?q=a#b' });
    expect(parseLinkUrl('localhost:3000')).toEqual({ ok: true, url: 'https://localhost:3000/' });
    expect(parseLinkUrl('HTTPS://Example.COM/Path')).toEqual({ ok: true, url: 'https://example.com/Path' });
    expect(parseLinkUrl('mail.google.com/mail/u/0/#inbox')).toEqual({ ok: true, url: 'https://mail.google.com/mail/u/0/#inbox' });
  });

  it('refuses anything that is not a web address', () => {
    for (const [text, problem] of [
      ['', 'empty'],
      ['   ', 'empty'],
      ['javascript:alert(1)', 'scheme'],
      ['JavaScript:alert(1)', 'scheme'],
      ['data:text/html,<b>x</b>', 'scheme'],
      ['file:///etc/passwd', 'scheme'],
      ['chrome://settings', 'scheme'],
      ['ftp://example.com', 'scheme'],
      ['mailto:me@example.com', 'scheme'],
      ['https://', 'invalid'],
      ['http://exa mple.com', 'invalid'],
      ['https://user:secret@example.com', 'credentials'],
      [`https://example.com/${'a'.repeat(2100)}`, 'long'],
    ] as const) {
      expect(parseLinkUrl(text), text).toEqual({ ok: false, problem });
    }
  });
});

describe('validateLinkDraft', () => {
  it('returns a clean name and URL; the name defaults to the site', () => {
    expect(validateLinkDraft({ name: '  Git   Hub ', url: 'github.com' })).toEqual({ ok: true, value: { name: 'Git Hub', url: 'https://github.com/' } });
    expect(validateLinkDraft({ name: '', url: 'https://www.news.example.com/today' })).toEqual({
      ok: true,
      value: { name: 'news.example.com', url: 'https://www.news.example.com/today' },
    });
  });

  it('explains what is wrong', () => {
    expect(validateLinkDraft({ name: '', url: '' })).toEqual({ ok: false, errors: { url: 'Enter a web address.' } });
    expect(validateLinkDraft({ name: 'x', url: 'javascript:alert(1)' })).toEqual({
      ok: false,
      errors: { url: 'Only web addresses (http:// or https://) can be added.' },
    });
    expect(validateLinkDraft({ name: 'x'.repeat(MAX_LINK_NAME_LENGTH + 1), url: 'example.com' })).toEqual({
      ok: false,
      errors: { name: 'Use at most 40 characters.' },
    });
  });
});

describe('letters and labels', () => {
  it('uses the first letter or digit of the name, uppercased', () => {
    expect(linkLetter({ name: 'github', url: 'https://github.com/' })).toBe('G');
    expect(linkLetter({ name: '  (Mail)', url: 'https://mail.example.com/' })).toBe('M');
    expect(linkLetter({ name: '9gag', url: 'https://9gag.com/' })).toBe('9');
    expect(linkLetter({ name: 'Пошта', url: 'https://ukr.net/' })).toBe('П');
    expect(linkLetter({ name: 'ísland', url: 'https://example.is/' })).toBe('Í');
    expect(linkLetter({ name: '🎵', url: 'https://music.example.com/' })).toBe('🎵');
    expect(linkLetter({ name: '', url: 'https://www.wikipedia.org/' })).toBe('W');
  });

  it('labels a site by its host without www.', () => {
    expect(hostLabel('https://www.example.com/a')).toBe('example.com');
    expect(hostLabel('not a url')).toBe('not a url');
  });
});

describe('list operations', () => {
  it('adds, updates, removes and puts a link back where it was', () => {
    const list = [link('a'), link('b'), link('c')];
    expect(addLink(list, createLink({ name: 'D', url: 'https://d.example.com/' }, 'd')).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(addLink(list, link('a'))).toEqual(list);
    expect(updateLink(list, 'b', { name: 'Bee', url: 'https://bee.example.com/' })[1]).toEqual({ id: 'b', name: 'Bee', url: 'https://bee.example.com/' });
    const removed = removeLink(list, 'b');
    expect(removed.map((l) => l.id)).toEqual(['a', 'c']);
    // Undo restores it at its old position.
    expect(addLink(removed, link('b'), undefined, undefined, 1).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(addLink(removed, link('b'), undefined, undefined, 99).map((l) => l.id)).toEqual(['a', 'c', 'b']);
  });

  it('reorders one place at a time and stops at the ends', () => {
    const list = [link('a'), link('b'), link('c')];
    expect(moveLink(list, 'a', 1).map((l) => l.id)).toEqual(['b', 'a', 'c']);
    expect(moveLink(list, 'c', -1).map((l) => l.id)).toEqual(['a', 'c', 'b']);
    expect(moveLink(list, 'a', -1).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(moveLink(list, 'c', 1).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(moveLink(list, 'missing', 1)).toEqual(list);
  });

  it('free keeps 6 links: adding is blocked, nothing existing is removed', () => {
    const max = listLimit('links', 'free', false);
    const message = limitMessage('links', 'free', false);
    expect(max).toBe(FREE_MAX_LINKS);
    expect(message).toBe('Free keeps 6 quick links. Pro removes the limit.');
    const eight = 'abcdefgh'.split('').map((id) => link(id));
    expect(() => addLink(eight, link('i'), max, message)).toThrow(new LinkLimitError(message));
    expect(addLink(eight.slice(0, 5), link('i'), max, message)).toHaveLength(6);
    // Undo after a delete restores without the plan limit.
    expect(addLink(eight, link('i'))).toHaveLength(9);
    expect(listLimit('links', 'pro', false)).toBe(PRO_MAX_LINKS);
    expect(PRO_MAX_LINKS).toBe(MAX_LINKS);
    expect(() => addLink(Array.from({ length: MAX_LINKS }, (_, i) => link(`l${i}`)), link('more'))).toThrow(LinkLimitError);
  });
});

describe('sanitizeLinks', () => {
  it('keeps valid web links only', () => {
    const result = sanitizeLinks([
      link('ok', '  Docs ', 'https://docs.example.org/'),
      link('ok', 'Duplicate'),
      { id: 'js', name: 'Evil', url: 'javascript:alert(1)' },
      { id: 'file', name: 'File', url: 'file:///C:/secret.txt' },
      { id: 'bare', name: '', url: 'news.example.com' },
      { id: 'no-url', name: 'x' },
      { id: '', name: 'No id', url: 'https://example.com' },
      null,
      42,
    ]);
    expect(result).toEqual([
      { id: 'ok', name: 'Docs', url: 'https://docs.example.org/' },
      { id: 'bare', name: 'news.example.com', url: 'https://news.example.com/' },
    ]);
    for (const raw of [undefined, null, 'links', {}]) expect(sanitizeLinks(raw)).toEqual([]);
    expect(sanitizeLinks(Array.from({ length: MAX_LINKS + 2 }, (_, i) => link(`l${i}`)))).toHaveLength(MAX_LINKS);
  });
});
