// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  cssEscape,
  describeElement,
  isHashedToken,
  isStableClass,
  isStableId,
  isUniqueMatch,
  selectorCandidates,
} from '../src/core/selector';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('generated-name detection', () => {
  it('flags CSS-in-JS, CSS modules and atomic class names', () => {
    for (const name of ['css-1x2y3z', 'sc-bdVaJa', 'jsx-2133742', 'Price_price__Xy1Z2', 'x1n2onr6', 'Button__Wrapper-sc-1x2y3z-0', 'svelte-1abc9z', 'astro-J7PV25F6', 'a1b2c3']) {
      expect(isHashedToken(name), name).toBe(true);
    }
  });

  it('keeps meaningful class names', () => {
    for (const name of ['price', 'product-title', 's-item__price', 'a-price-whole', 'col-md-6', 'h1', 'MuiButton-root', 'card__title', 'productTitle', 'js-price']) {
      expect(isHashedToken(name), name).toBe(false);
    }
  });

  it('skips state classes and names that need escaping', () => {
    expect(isStableClass('active')).toBe(false);
    expect(isStableClass('is-open')).toBe(false);
    expect(isStableClass('w-1/2')).toBe(false);
    expect(isStableClass('price')).toBe(true);
  });

  it('rejects generated ids', () => {
    for (const id of [':r1:', '«r3»', 'ember123', 'react-select-5-input', '123abc', 'mui-42', 'headlessui-menu-1', 'a9f3k2l1']) {
      expect(isStableId(id), id).toBe(false);
    }
    for (const id of ['price', 'main-content', 'product_title', 'comment-123456']) expect(isStableId(id), id).toBe(true);
  });
});

describe('cssEscape', () => {
  it('matches CSS.escape for tricky identifiers', () => {
    expect(cssEscape('a.b')).toBe('a\\.b');
    expect(cssEscape('1a')).toBe('\\31 a');
    expect(cssEscape('-1')).toBe('-\\31 ');
    expect(cssEscape('-')).toBe('\\-');
    expect(cssEscape('ümlaut_ok-1')).toBe('ümlaut_ok-1');
    expect(cssEscape('a b')).toBe('a\\ b');
  });
});

describe('selectorCandidates', () => {
  it('prefers a stable id', () => {
    const doc = parse('<div class="css-1x2y3z"><span id="price" class="amount">$5</span></div>');
    const [first] = selectorCandidates(doc.getElementById('price')!);
    expect(first).toBe('#price');
  });

  it('prefers a test id over hashed classes', () => {
    const doc = parse('<div class="sc-AxjAm"><span data-testid="price" class="css-9z8y7x">$5</span></div>');
    const element = doc.querySelector('span')!;
    const candidates = selectorCandidates(element);
    expect(candidates[0]).toBe('[data-testid="price"]');
    expect(candidates.join(' ')).not.toMatch(/css-|sc-/);
  });

  it('skips generated ids and anchors on a stable ancestor', () => {
    const doc = parse(`<main id="product"><div class="css-abc123"><p>Name</p><p id=":r5:">$10</p></div></main>`);
    const element = doc.querySelectorAll('p')[1]!;
    const candidates = selectorCandidates(element);
    expect(candidates[0]).toBe('#product > div > p:nth-of-type(2)');
    for (const selector of candidates) expect(isUniqueMatch(doc, selector, element)).toBe(true);
  });

  it('uses meaningful classes to stay short', () => {
    const doc = parse(`<ul><li class="job"><h3 class="job-title">A</h3></li><li class="job"><h3 class="job-title">B</h3></li></ul>
      <p class="results-count">2 jobs</p>`);
    expect(selectorCandidates(doc.querySelector('.results-count')!)[0]).toBe('p.results-count');
    const second = doc.querySelectorAll('li')[1]!;
    expect(selectorCandidates(second)[0]).toBe('li.job:nth-of-type(2)');
  });

  it('every candidate matches only the picked element', () => {
    const doc = parse(`<body><div><section><div><span>1</span><span>2</span></div><div><span>3</span><span>4</span></div></section></div>
      <div itemprop="offers"><span itemprop="price">9.99</span></div></body>`);
    for (const element of Array.from(doc.querySelectorAll('span'))) {
      const candidates = selectorCandidates(element);
      expect(candidates.length).toBeGreaterThan(0);
      for (const selector of candidates) expect(isUniqueMatch(doc, selector, element), selector).toBe(true);
    }
    expect(selectorCandidates(doc.querySelector('[itemprop="price"]')!)[0]).toBe('[itemprop="price"]');
  });

  it('always has a structural fallback', () => {
    const doc = parse('<body><div><div><b>x</b></div><div><b>y</b></div></div></body>');
    const target = doc.querySelectorAll('b')[1]!;
    const candidates = selectorCandidates(target);
    expect(candidates.at(-1)).toBe('body > div > div:nth-of-type(2) > b');
  });

  it('escapes ids that need it', () => {
    const doc = parse('<p id="price.now">1</p>');
    expect(selectorCandidates(doc.querySelector('p')!)[0]).toBe('#price\\.now');
  });
});

describe('describeElement', () => {
  it('shows tag, id and readable classes', () => {
    const doc = parse('<span id="p" class="css-1x2y3z amount big extra">1</span>');
    expect(describeElement(doc.querySelector('span')!)).toBe('span#p.amount.big');
  });
});
