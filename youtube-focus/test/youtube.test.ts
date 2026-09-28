import { describe, expect, it } from 'vitest';
import { FEATURES } from '../src/core/settings';
import { buildHideCss, HIDE_ATTR, HIDE_RULES, ROUTE_ATTR } from '../src/sites/youtube';

describe('HIDE_RULES', () => {
  it('covers every free feature plus subscriptions-only', () => {
    const tokens = new Set(HIDE_RULES.map((rule) => rule.token));
    for (const feature of FEATURES) expect(tokens.has(feature)).toBe(true);
    expect(tokens.has('explore')).toBe(true);
  });

  it('uses the element names the README lists as unverified', () => {
    const all = HIDE_RULES.flatMap((rule) => rule.selectors);
    for (const expected of [
      'ytd-reel-shelf-renderer',
      'ytd-rich-shelf-renderer[is-shorts]',
      'ytd-comments#comments',
      'ytd-watch-flexy #related',
      '.html5-video-player .ytp-ce-element',
      'ytd-guide-entry-renderer:has(a#endpoint[title="Shorts"])',
    ]) {
      expect(all).toContain(expected);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('has no characters that could break out of a rule', () => {
    for (const selector of HIDE_RULES.flatMap((rule) => rule.selectors)) expect(selector).not.toMatch(/[{};]/);
  });
});

describe('buildHideCss', () => {
  const css = buildHideCss();
  const rules = css.split('\n').filter((line) => line.startsWith('html'));

  it('emits one rule per selector (and per route), all gated on <html> attributes', () => {
    const expected = HIDE_RULES.reduce((sum, rule) => sum + rule.selectors.length * (rule.routes?.length ?? 1), 0);
    expect(rules).toHaveLength(expected);
    for (const rule of rules) {
      expect(rule).toMatch(new RegExp(`^html\\[${HIDE_ATTR}~="[a-z]+"\\]`));
      expect(rule.endsWith('{display:none!important}')).toBe(true);
    }
  });

  it('gates the home feed on the home route', () => {
    expect(css).toContain(`html[${HIDE_ATTR}~="home"][${ROUTE_ATTR}="home"] ytd-browse[page-subtype="home"] ytd-rich-grid-renderer{display:none!important}`);
    expect(css).toContain(`html[${HIDE_ATTR}~="comments"] ytd-comments#comments{display:none!important}`);
  });
});
