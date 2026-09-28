import { describe, expect, it } from 'vitest';
import {
  buildTextFragment,
  encodeTerm,
  foldForMatch,
  formatDirective,
  quoteBaseUrl,
  resolveDirective,
  snapToWords,
  withTextFragment,
  type FragmentResult,
  type PageTextModel,
} from '../src/core/textFragment';

/** A page model with the first occurrence of `selected` (or the `nth`) as the selection. */
function model(text: string, selected: string, nth = 1): PageTextModel {
  let start = -1;
  for (let i = 0; i < nth; i++) start = text.indexOf(selected, start + 1);
  if (start === -1) throw new Error(`"${selected}" not in the page`);
  return { text, start, end: start + selected.length };
}

function fragment(result: FragmentResult): string {
  if (result.status !== 'ok') throw new Error(`expected a fragment, got ${result.status}`);
  return result.fragment;
}

/** The browser (as simulated) lands exactly on the selection. */
function landsOn(page: PageTextModel, result: FragmentResult): boolean {
  if (result.status !== 'ok') return false;
  const found = resolveDirective(page.text, result.directive);
  return found?.start === page.start && found.end === page.end;
}

describe('buildTextFragment', () => {
  it('quotes a short, unique passage as textStart', () => {
    const page = model('Night trains return\nThe sleeper from Vienna reaches Rome by breakfast.\nTickets go on sale in June.', 'reaches Rome by breakfast');
    const result = buildTextFragment(page);
    expect(fragment(result)).toBe('text=reaches%20Rome%20by%20breakfast');
    expect(landsOn(page, result)).toBe(true);
  });

  it('adds a prefix when the passage also appears earlier on the page', () => {
    const text = [
      'Night trains return',
      '“We are bringing the night train back,” said the minister.',
      'After years of cuts, the minister told reporters: “We are bringing the night train back,” and promised more routes.',
    ].join('\n');
    const page = model(text, 'We are bringing the night train back', 2);
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive.prefix).toBeDefined();
    expect(result.fragment).toMatch(/^text=[^,]+-,We%20are%20bringing%20the%20night%20train%20back$/);
    expect(landsOn(page, result)).toBe(true);
    // Without context the first copy would win.
    expect(resolveDirective(text, { textStart: 'We are bringing the night train back' })?.start).toBe(text.indexOf('We are'));
  });

  it('uses a suffix when the words before the passage do not tell the copies apart', () => {
    const text = 'Fares\nRead more\nFares\nRead more about fares';
    const page = model(text, 'Read more', 2);
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive.suffix).toBe('about');
    expect(landsOn(page, result)).toBe(true);
  });

  it('takes context from the neighbouring block when the passage fills its own', () => {
    const text = 'Step one\nOpen the settings.\nStep two\nOpen the settings.';
    const page = model(text, 'Open the settings.', 2);
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive).toEqual({ prefix: 'two', textStart: 'Open the settings.' });
    expect(landsOn(page, result)).toBe(true);
  });

  it('reports identical passages that no context can tell apart', () => {
    const text = 'Reply\nReply\nReply';
    expect(buildTextFragment(model(text, 'Reply', 3)).status).toBe('ambiguous');
    // The first one needs no context at all, the second is the first "Reply" after a "Reply".
    expect(fragment(buildTextFragment(model(text, 'Reply', 1)))).toBe('text=Reply');
    expect(fragment(buildTextFragment(model(text, 'Reply', 2)))).toBe('text=Reply-,Reply');
  });

  it('uses textStart,textEnd for long passages', () => {
    const paragraph =
      'The new timetable starts in December. Sleepers leave Vienna at 19:40 and reach Rome at 09:55, with a stop in Florence. ' +
      'Couchettes cost from 69 euros, a private compartment with a shower from 199 euros, and bikes travel for 15 euros.';
    const text = `Night trains return\n${paragraph}\nMore routes are planned for 2027.`;
    const page = model(text, paragraph);
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive).toEqual({ textStart: 'The new timetable', textEnd: 'for 15 euros.' });
    expect(result.fragment).toBe('text=The%20new%20timetable,for%2015%20euros.');
    expect(landsOn(page, result)).toBe(true);
  });

  it('spans several blocks with textStart in the first and textEnd in the last', () => {
    const text = 'Intro line here\nFirst paragraph of the quote.\nSecond paragraph ends here.\nOutro';
    const page = { text, start: text.indexOf('First'), end: text.indexOf('here.') + 5 };
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive).toEqual({ textStart: 'First paragraph of', textEnd: 'paragraph ends here.' });
    expect(landsOn(page, result)).toBe(true);
  });

  it('adds more words when the first words of a long passage repeat', () => {
    const repeated = 'In this article we explain how the new timetable affects commuters and what changes for families who travel together.';
    const text = `In this article we look at prices.\n${repeated}`;
    const page = model(text, repeated);
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive.textStart).not.toBe('In this article');
    expect(landsOn(page, result)).toBe(true);
  });

  it('makes sure textEnd is the first one after textStart', () => {
    const body =
      'Delays are expected on Monday because of track works near Salzburg, so please check the timetable. ' +
      'On Tuesday the route is clear again and trains run as planned, so please check the timetable.';
    const text = `Service update\n${body} Thank you.`;
    // Select up to the first "check the timetable." only.
    const selected = body.slice(0, body.indexOf('timetable.') + 'timetable.'.length);
    const page = model(text, selected);
    const result = buildTextFragment(page);
    expect(landsOn(page, result)).toBe(true);
  });

  it('snaps a selection that starts or ends inside a word to whole words', () => {
    const text = 'The sleeper from Vienna reaches Rome by breakfast.';
    const page = { text, start: text.indexOf('eeper'), end: text.indexOf('Vien') + 4 };
    expect(snapToWords(text, page.start, page.end)).toEqual({ start: text.indexOf('sleeper'), end: text.indexOf('Vienna') + 6 });
    expect(fragment(buildTextFragment(page))).toBe('text=sleeper%20from%20Vienna');
  });

  it('does not treat a match inside a longer word as the passage', () => {
    const text = 'Categories: travel\nThe cat sat on the mat.';
    const page = model(text, 'cat sat', 1);
    const result = buildTextFragment(page);
    expect(landsOn(page, result)).toBe(true);
  });

  it('matches case- and accent-insensitively, like the browser', () => {
    const text = 'Cafe opening hours\nThe café opens at eight.';
    // "Cafe" and "café" fold to the same text, so the second needs context.
    const page = model(text, 'café');
    const result = buildTextFragment(page);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.directive.prefix ?? result.directive.suffix).toBeDefined();
    expect(landsOn(page, result)).toBe(true);
    expect(foldForMatch('Ça Été “Q”')).toBe('ca ete "q"');
  });

  it('handles punctuation and encodes directive syntax', () => {
    const text = 'Q&A: fares, discounts - and the 50% rule (for kids)\nNext';
    const page = model(text, 'Q&A: fares, discounts - and the 50% rule (for kids)');
    expect(fragment(buildTextFragment(page))).toBe('text=Q%26A%3A%20fares%2C%20discounts%20%2D%20and%20the%2050%25%20rule%20%28for%20kids%29');
    expect(encodeTerm('a-b,c&d')).toBe('a%2Db%2Cc%26d');
  });

  it('works with non-Latin text', () => {
    const cyrillic = 'Київ — столиця України.\nКиїв розташований на Дніпрі. Київ — столиця України.';
    const page = model(cyrillic, 'Київ — столиця України.', 2);
    const result = buildTextFragment(page);
    expect(landsOn(page, result)).toBe(true);
    expect(result.status === 'ok' && result.fragment).toContain(encodeURIComponent('Київ'));

    const japanese = '東京は日本の首都です。\n大阪は日本の都市です。東京は日本の首都です。';
    const jaPage = model(japanese, '東京は日本の首都です。', 2);
    expect(landsOn(jaPage, buildTextFragment(jaPage))).toBe(true);
  });

  it('normalizes whitespace at the edges of the selection', () => {
    const text = 'Title\nTickets go on sale in June.\nEnd';
    const start = text.indexOf('Tickets') - 1; // the block break before it
    const page = { text, start, end: text.indexOf('June.') + 5 + 1 };
    expect(fragment(buildTextFragment(page))).toBe('text=Tickets%20go%20on%20sale%20in%20June.');
  });

  it('returns empty for whitespace or punctuation only', () => {
    expect(buildTextFragment({ text: 'a   b', start: 1, end: 4 }).status).toBe('empty');
    expect(buildTextFragment({ text: 'a — b', start: 1, end: 4 }).status).toBe('empty');
  });

  it('handles very long selections quickly and with short links', () => {
    const sentences = Array.from({ length: 400 }, (_, i) => `Sentence number ${i + 1} talks about trains, stations and timetables.`);
    const text = `Header\n${sentences.join(' ')}\nFooter`;
    const selected = sentences.slice(10, 390).join(' ');
    const page = model(text, selected);
    const started = performance.now();
    const result = buildTextFragment(page);
    expect(performance.now() - started).toBeLessThan(500);
    expect(landsOn(page, result)).toBe(true);
    expect(result.status === 'ok' && result.fragment.length).toBeLessThan(200);
  });

  it('formats every part of a directive', () => {
    expect(formatDirective({ prefix: 'said:', textStart: 'We are', textEnd: 'back', suffix: 'and' })).toBe('text=said%3A-,We%20are,back,-and');
  });
});

describe('quote URLs', () => {
  it('drops tracking parameters, old directives and in-page anchors', () => {
    expect(quoteBaseUrl('https://news.example.com/a?id=4&utm_source=x#comments')).toBe('https://news.example.com/a?id=4');
    expect(quoteBaseUrl('https://news.example.com/a#:~:text=old')).toBe('https://news.example.com/a');
    expect(quoteBaseUrl('https://news.example.com/a?fbclid=1')).toBe('https://news.example.com/a');
  });

  it('keeps single-page-app hash routes', () => {
    expect(quoteBaseUrl('https://mail.example.com/#/inbox/42:~:text=old')).toBe('https://mail.example.com/#/inbox/42');
    expect(withTextFragment('https://mail.example.com/#/inbox/42', 'text=hi')).toBe('https://mail.example.com/#/inbox/42:~:text=hi');
    expect(quoteBaseUrl('https://x.example.com/#!/post/1')).toBe('https://x.example.com/#!/post/1');
  });

  it('only links web pages', () => {
    expect(quoteBaseUrl('chrome://version')).toBeNull();
    expect(quoteBaseUrl('file:///tmp/a.html')).toBeNull();
    expect(withTextFragment('https://a.example.com/p', 'text=x')).toBe('https://a.example.com/p#:~:text=x');
    expect(withTextFragment('https://a.example.com/p', null)).toBe('https://a.example.com/p');
  });
});
