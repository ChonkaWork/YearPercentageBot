// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanCopy, collapseSpaces, describeClean, mergeLines, stripBullets } from '../src/core/cleaner';
import type { Rule } from '../src/core/rules';
import { defaultSettings, type CleanOptions } from '../src/core/settings';
import { cleanSelection } from '../src/page/selection';
import { $, render, selectContents, snapshotOf } from './helpers';

const defaults = defaultSettings();
const plain = (text: string, options: Partial<CleanOptions> = {}, rules: Rule[] | null = null) => cleanCopy({ kind: 'plain', text }, { ...defaults, ...options }, rules);
const dom = (html: string, options: Partial<CleanOptions> = {}, rules: Rule[] | null = null) =>
  cleanCopy({ kind: 'dom', nodes: snapshotOf(html), url: 'https://example.com/docs/' }, { ...defaults, ...options }, rules);

describe('cleanCopy: from the page', () => {
  it('drops formatting, links and hidden text, keeps structure', () => {
    const { text } = dom(
      '<h2 style="font-family:Comic Sans;color:red">Release <span style="color:blue">notes</span></h2>' +
        '<p>Read <a href="https://example.com/guide?utm_source=x">the <b>guide</b></a> first.<span style="display:none"> hidden</span></p>' +
        '<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>',
    );
    expect(text).toBe('Release notes\n\nRead the guide first.\n\n- One\n- Two\n  - Nested');
  });

  it('counts and removes invisible characters', () => {
    const result = dom('<p>Zero​width and soft­hyphen﻿</p>');
    expect(result.text).toBe('Zerowidth and softhyphen');
    expect(result.stats.invisible).toBe(3);
  });

  it('strips tracking parameters from visible addresses', () => {
    const result = dom('<p>Link: https://example.com/p?utm_source=news&amp;id=3</p>');
    expect(result.text).toBe('Link: https://example.com/p?id=3');
    expect(result.stats.trackingParams).toBe(1);
    expect(dom('<p>Link: https://example.com/p?utm_source=news</p>', { stripTracking: false }).text).toBe('Link: https://example.com/p?utm_source=news');
  });

  it('can drop bullets and merge lines', () => {
    expect(dom('<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>', { keepBullets: false }).text).toBe('One\nTwo\n\n1. First');
    expect(dom('<div style="white-space:pre-wrap">wrapped\nline\n\nnext</div>', { lineBreaks: 'merge' }).text).toBe('wrapped line\n\nnext');
  });

  it('reads a live selection, including one inside a text field (never a password)', () => {
    render('<p id="p">Some   <em>text</em></p><textarea id="t">a  b​</textarea><input id="pw" type="password" value="secret">');
    selectContents($('#p'));
    expect(cleanSelection(document, defaults, null)).toMatchObject({ kind: 'dom', text: 'Some text', truncated: false });

    const field = $('#t') as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, field.value.length);
    expect(cleanSelection(document, defaults, null)).toMatchObject({ kind: 'plain', text: 'a b' });

    const password = $('#pw') as HTMLInputElement;
    password.focus();
    getSelection()?.removeAllRanges();
    expect(cleanSelection(document, defaults, null).kind).toBe('empty');
  });
});

describe('cleanCopy: plain text', () => {
  it('normalizes line endings, invisible characters and no-break spaces', () => {
    expect(plain('a\r\nb c​  \r\n\r\n\r\n\r\nd').text).toBe('a\nb c\n\nd');
  });

  it('collapses runs of spaces but keeps indentation and tabs', () => {
    expect(plain('a    b\n    indented   code\nx\t\ty  ').text).toBe('a b\n    indented code\nx\t\ty');
    expect(plain('a    b', { collapseWhitespace: false }).text).toBe('a    b');
  });

  it('applies custom rules after the built-in cleanup', () => {
    const rules: Rule[] = [{ id: 'a', enabled: true, mode: 'regex', find: '^Read more at:.*$\\n?', replace: '', caseSensitive: false }];
    const result = plain('Story text.\nRead more at: https://example.com/x?utm_source=a', {}, rules);
    expect(result.text).toBe('Story text.');
    expect(result.stats).toMatchObject({ trackingParams: 1, replacements: 1, rulesApplied: 1 });
  });

  it('ignores rules when none are passed (free plan)', () => {
    expect(plain('abc', {}, null).text).toBe('abc');
    expect(plain('abc', {}, []).text).toBe('abc');
  });

  it('reports rules stopped by a limit', () => {
    let clock = 0;
    const rules: Rule[] = [{ id: 'a', enabled: true, mode: 'text', find: 'a', replace: 'b', caseSensitive: false }];
    const result = cleanCopy({ kind: 'plain', text: 'a a a' }, defaults, rules, { now: () => (clock += 100), timeBudgetMs: 50 });
    expect(result.stats.rulesStopped).toBe('time');
  });
});

describe('steps', () => {
  it('mergeLines joins wrapped lines and hyphenated words, keeps paragraphs, lists and table rows', () => {
    expect(mergeLines('We rebuilt the\neditor from scr-\natch.\n\nNext para-\nGraph\n- item one\n  continued\n- item two\n1) first\nA\tB\n1\t2')).toBe(
      'We rebuilt the editor from scratch.\n\nNext para- Graph\n- item one continued\n- item two\n1) first\nA\tB\n1\t2',
    );
  });

  it('stripBullets removes bullet glyphs and list indentation, keeps numbers', () => {
    expect(stripBullets('- a\n  • b\n* c\n  2. d\n-not a bullet\n– e')).toBe('a\nb\nc\n2. d\n-not a bullet\ne');
  });

  it('collapseSpaces empties whitespace-only lines', () => {
    expect(collapseSpaces('a  \n   \n\tb   c')).toBe('a\n\n\tb c');
  });

  it('describeClean summarizes what happened', () => {
    expect(describeClean({ invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0 }, 1)).toBe('1 character');
    expect(describeClean({ invisible: 3, trackingParams: 1, replacements: 5, rulesApplied: 2 }, 1200)).toBe(
      '1,200 characters · removed 1 tracking parameter and 3 invisible characters · 2 rules applied',
    );
    expect(describeClean({ invisible: 0, trackingParams: 0, replacements: 0, rulesApplied: 0, rulesStopped: 'time' }, 5)).toMatch(/some rules skipped/);
  });
});
