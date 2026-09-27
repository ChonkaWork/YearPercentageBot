import { describe, expect, it } from 'vitest';
import {
  bareUrl,
  cleanImageUrl,
  cleanLinkUrl,
  isFootnoteMarker,
  isSamePageLink,
  languageFromClass,
  normalizePlainText,
  removeInvisible,
  sanitizeLanguage,
  tidyText,
} from '../src/core/text';

describe('removeInvisible', () => {
  it('drops zero-width spaces, BOM, word joiners and soft hyphens but keeps emoji joiners', () => {
    expect(removeInvisible('he​llo﻿ wo­rld⁠ 👨‍👩‍👧')).toBe('hello world 👨‍👩‍👧');
  });

  it('turns no-break and narrow no-break spaces into regular spaces', () => {
    expect(removeInvisible('1 299 ₴')).toBe('1 299 ₴');
  });
});

describe('tidyText / normalizePlainText', () => {
  it('trims trailing spaces, keeps tabs (empty table cells) and collapses blank lines', () => {
    expect(tidyText('\n\na  \nb\t\n\n\n\nc\n\n')).toBe('a\nb\t\n\nc');
  });

  it('normalizes CRLF and invisible characters in plain text', () => {
    expect(normalizePlainText('one\r\ntwo​  \r\n\r\n\r\nthree')).toBe('one\ntwo\n\nthree');
  });
});

describe('cleanLinkUrl', () => {
  it('resolves relative links against the page', () => {
    expect(cleanLinkUrl('../guide/intro.html#setup', 'https://example.com/docs/a/page.html')).toBe(
      'https://example.com/docs/guide/intro.html#setup',
    );
  });

  it('removes tracking parameters but keeps meaningful ones', () => {
    expect(cleanLinkUrl('https://shop.example/item?id=42&utm_source=news&utm_medium=email&fbclid=abc')).toBe('https://shop.example/item?id=42');
    expect(cleanLinkUrl('https://example.com/?utm_campaign=x')).toBe('https://example.com/');
    expect(cleanLinkUrl('https://example.com/search?q=a+b&page=2')).toBe('https://example.com/search?q=a+b&page=2');
  });

  it('rejects script and data URLs, keeps mailto and tel', () => {
    expect(cleanLinkUrl('javascript:alert(1)')).toBeNull();
    expect(cleanLinkUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(cleanLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(cleanLinkUrl('vbscript:msgbox')).toBeNull();
    expect(cleanLinkUrl('mailto:team@example.com')).toBe('mailto:team@example.com');
    expect(cleanLinkUrl('tel:+380441234567')).toBe('tel:+380441234567');
    expect(cleanLinkUrl('')).toBeNull();
  });
});

describe('cleanImageUrl', () => {
  it('keeps http(s) and raster data images, rejects SVG data and other schemes', () => {
    expect(cleanImageUrl('/img/a.png', 'https://example.com/docs/')).toBe('https://example.com/img/a.png');
    expect(cleanImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(cleanImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(cleanImageUrl('javascript:alert(1)')).toBeNull();
    expect(cleanImageUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('links', () => {
  it('detects links to the same page', () => {
    expect(isSamePageLink('https://example.com/a#b', 'https://example.com/a#c')).toBe(true);
    expect(isSamePageLink('https://example.com/b', 'https://example.com/a')).toBe(false);
  });

  it('compares URLs without scheme, www and trailing slash', () => {
    expect(bareUrl('https://www.example.com/')).toBe('example.com');
    expect(bareUrl('mailto:a@b.c')).toBe('a@b.c');
  });
});

describe('languageFromClass', () => {
  it('reads GitHub, highlight.js, Prism and SyntaxHighlighter classes', () => {
    expect(languageFromClass('language-js')).toBe('js');
    expect(languageFromClass('hljs lang-Python')).toBe('python');
    expect(languageFromClass('highlight highlight-source-shell')).toBe('shell');
    expect(languageFromClass('brush: ruby; toolbar: false')).toBe('ruby');
    expect(languageFromClass('language-none')).toBeNull();
    expect(languageFromClass('code-block')).toBeNull();
  });

  it('rejects anything that is not a plausible language name', () => {
    expect(sanitizeLanguage('c++')).toBe('c++');
    expect(sanitizeLanguage('js"><script>')).toBeNull();
  });
});

describe('isFootnoteMarker', () => {
  it('matches citation markers and edit links', () => {
    for (const value of ['[1]', '[ 12 ]', '[a]', '[citation needed]', '[edit]', '[note 3]']) expect(isFootnoteMarker(value)).toBe(true);
    for (const value of ['2', 'x[1]', '[1] and more', '[]']) expect(isFootnoteMarker(value)).toBe(false);
  });
});
