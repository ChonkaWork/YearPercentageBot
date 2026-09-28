import { describe, expect, it } from 'vitest';
import { applyEditsToText } from '../src/core/changes';
import { isTrackingParam, stripTrackingFromUrl, stripTrackingParams, stripTrackingStep, trimUrlEnd } from '../src/core/urls';

describe('stripTrackingFromUrl', () => {
  it('removes utm_* and click ids, keeps the other parameters in order', () => {
    expect(stripTrackingFromUrl('https://example.com/a?utm_source=x&id=7&fbclid=abc&utm_medium=email&q=hi').url).toBe('https://example.com/a?id=7&q=hi');
  });

  it('drops the question mark when nothing is left and keeps the fragment', () => {
    expect(stripTrackingFromUrl('https://example.com/a?gclid=1&utm_campaign=x#section-2')).toEqual({ url: 'https://example.com/a#section-2', removed: 2 });
  });

  it('never re-encodes what it keeps', () => {
    const url = 'https://example.com/search?q=caf%C3%A9+au+lait&x=%2F%2F&utm_source=a';
    expect(stripTrackingFromUrl(url).url).toBe('https://example.com/search?q=caf%C3%A9+au+lait&x=%2F%2F');
  });

  it('leaves URLs without tracking untouched (even odd ones)', () => {
    for (const url of ['https://example.com/?a=1&&b=2', 'https://example.com/?=x', 'http://user@host:8080/p?ref=1']) {
      expect(stripTrackingFromUrl(url)).toEqual({ url, removed: 0 });
    }
  });

  it('matches parameter names case-insensitively and decodes them', () => {
    expect(stripTrackingFromUrl('https://example.com/?UTM_Source=x&%66bclid=y&keep=1').url).toBe('https://example.com/?keep=1');
  });

  it('applies site-specific parameters only on their sites', () => {
    expect(stripTrackingFromUrl('https://youtu.be/dQw4w9WgXcQ?si=abc&t=42').url).toBe('https://youtu.be/dQw4w9WgXcQ?t=42');
    expect(stripTrackingFromUrl('https://example.com/?si=abc').url).toBe('https://example.com/?si=abc');
    expect(stripTrackingFromUrl('https://www.amazon.de/dp/B00X?ref=abc&pd_rd_w=1&th=1').url).toBe('https://www.amazon.de/dp/B00X?th=1');
    expect(stripTrackingFromUrl('https://docs.example.com/page?ref=abc').url).toBe('https://docs.example.com/page?ref=abc');
  });

  it('knows which names are tracking', () => {
    expect(isTrackingParam('utm_content')).toBe(true);
    expect(isTrackingParam('msclkid')).toBe(true);
    expect(isTrackingParam('page')).toBe(false);
    expect(isTrackingParam('s', 'x.com')).toBe(true);
    expect(isTrackingParam('s', 'example.com')).toBe(false);
  });
});

describe('trimUrlEnd', () => {
  it('splits sentence punctuation off the address', () => {
    expect(trimUrlEnd('https://example.com/a.')).toEqual({ url: 'https://example.com/a', rest: '.' });
    expect(trimUrlEnd('https://example.com/a?x=1),')).toEqual({ url: 'https://example.com/a?x=1', rest: '),' });
  });

  it('keeps balanced parentheses that are part of the address', () => {
    expect(trimUrlEnd('https://en.wikipedia.org/wiki/Kyiv_(city)')).toEqual({ url: 'https://en.wikipedia.org/wiki/Kyiv_(city)', rest: '' });
  });
});

describe('stripTrackingParams (in running text)', () => {
  it('cleans every address and counts the removed parameters', () => {
    const text = 'See https://example.com/a?utm_source=nl&id=1. Also (https://shop.example.com/?gclid=x) and http://plain.example.com/.';
    expect(stripTrackingParams(text)).toEqual({
      text: 'See https://example.com/a?id=1. Also (https://shop.example.com/) and http://plain.example.com/.',
      removed: 2,
    });
  });

  it('handles addresses at line ends, in quotes and next to non-breaking punctuation', () => {
    expect(stripTrackingParams('"https://a.example/?fbclid=1"\nhttps://b.example/x?utm_term=y').text).toBe('"https://a.example/"\nhttps://b.example/x');
  });

  it('does not touch text without addresses', () => {
    const text = 'utm_source=newsletter is a parameter name, not a link.';
    expect(stripTrackingParams(text)).toEqual({ text, removed: 0 });
  });
});

describe('stripTrackingStep (edits for "Show changes")', () => {
  const removedParts = (text: string) => {
    const step = stripTrackingStep(text);
    expect(applyEditsToText(text, step.edits)).toBe(step.text);
    return step.edits.map((edit) => text.slice(edit.start, edit.end));
  };

  it('reports whole parameters with their separators', () => {
    expect(removedParts('https://example.com/a?utm_source=x&id=7&fbclid=abc&utm_medium=email&q=hi')).toEqual(['utm_source=x&', '&fbclid=abc&utm_medium=email']);
    expect(removedParts('see https://example.com/a?gclid=1&utm_campaign=x#top.')).toEqual(['?gclid=1&utm_campaign=x']);
    expect(removedParts('https://example.com/?a=1&&utm_source=x&b=2')).toEqual(['&&utm_source=x']);
    expect(removedParts('no links here, utm_source=x')).toEqual([]);
  });

  it('gives the same text as stripTrackingParams', () => {
    const text = 'See https://example.com/a?utm_source=nl&id=1. Also (https://shop.example.com/?gclid=x) and https://youtu.be/v?si=1&t=4';
    expect(stripTrackingStep(text)).toMatchObject(stripTrackingParams(text));
  });
});
