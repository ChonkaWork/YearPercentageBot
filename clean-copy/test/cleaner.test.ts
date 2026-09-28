// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { changeKinds, resultText, sourceText, type Segment } from '../src/core/changes';
import { cleanCopy, collapseSpaces, describeClean, mergeLines, stripBullets, TRACK_LIMIT } from '../src/core/cleaner';
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

describe('cleanCopy: show changes (structured, from the steps)', () => {
  const tracked = (text: string, options: Partial<CleanOptions> = {}, rules: Rule[] | null = null) =>
    cleanCopy({ kind: 'plain', text }, { ...defaults, ...options }, rules, { track: true });
  const removed = (segments: Segment[] = [], kind?: string) => segments.filter((segment) => segment.op === 'del' && (!kind || segment.kind === kind)).map((segment) => segment.text);

  it('says what went and why; the kept and added runs are exactly the clean text', () => {
    const input = 'Our   pricing​ page:\r\nhttps://example.com/p?plan=pro&utm_source=nl&fbclid=abc\r\n\r\n\r\nNext  ';
    const result = tracked(input);
    const changes = result.changes ?? [];
    expect(resultText(changes)).toBe(result.text);
    expect(sourceText(changes)).toBe(input.replace(/\r\n/g, '\n'));
    expect(removed(changes, 'invisible')).toEqual(['​']);
    expect(removed(changes, 'tracking')).toEqual(['&utm_source=nl&fbclid=abc']);
    expect(removed(changes, 'whitespace')).toEqual(['  ', '\n', '  ']);
  });

  it('tracks merged line breaks, bullets, typography, Markdown and rules', () => {
    const rules: Rule[] = [{ id: 'a', enabled: true, mode: 'text', find: 'Sent from my iPhone', replace: '', caseSensitive: true }];
    const result = tracked('## “News”\n\n* one\n* two\n\nwrapped\nline\n\nSent from my iPhone', { lineBreaks: 'merge', keepBullets: false, typography: true, removeMarkdown: true }, rules);
    expect(result.text).toBe('"News"\n\none\ntwo\n\nwrapped line');
    const changes = result.changes ?? [];
    expect(resultText(changes)).toBe(result.text);
    expect(removed(changes, 'markdown')).toEqual(['## ', '*', '*']);
    // The "- " that replaced "* " was then removed by "Keep bullets" off: it never shows as added.
    expect(changes.some((segment) => segment.op === 'ins' && segment.kind === 'markdown')).toBe(false);
    const kept = tracked('* one', { removeMarkdown: true }).changes ?? [];
    expect(kept).toEqual([{ text: '*', op: 'del', kind: 'markdown' }, { text: '-', op: 'ins', kind: 'markdown' }, { text: ' one' }]);
    expect(removed(changes, 'typography')).toEqual(['“', '”']);
    expect(removed(changes, 'line-break')).toEqual(['\n']);
    expect(removed(changes, 'rule')).toEqual(['Sent from my iPhone']);
    expect(changeKinds(changes)).toEqual(['whitespace', 'line-break', 'bullet', 'typography', 'markdown', 'rule']);
    expect(result.stats).toMatchObject({ typography: 2, markdown: 3, rulesApplied: 1 });
  });

  it('shows invisible characters removed from a page selection', () => {
    const result = cleanCopy({ kind: 'dom', nodes: snapshotOf('<p>Zero​width and <b>soft­hyphen</b></p><p>Link: https://example.com/?utm_source=x</p>'), url: 'https://example.com/' }, defaults, null, { track: true });
    expect(result.text).toBe('Zerowidth and softhyphen\n\nLink: https://example.com/');
    const changes = result.changes ?? [];
    expect(removed(changes, 'invisible')).toEqual(['​', '­']);
    expect(removed(changes, 'tracking')).toEqual(['?utm_source=x']);
    expect(resultText(changes)).toBe(result.text);
  });

  it('keeps link addresses when asked, with their tracking parameters removed as a visible change', () => {
    const result = cleanCopy(
      { kind: 'dom', nodes: snapshotOf('<p>Read <a href="guide?utm_source=x&amp;id=2">the guide</a>.</p>'), url: 'https://example.com/docs/' },
      { ...defaults, keepLinkUrls: true },
      null,
      { track: true },
    );
    expect(result.text).toBe('Read the guide (https://example.com/docs/guide?id=2).');
    expect(removed(result.changes, 'tracking')).toEqual(['utm_source=x&']);
    expect(cleanCopy({ kind: 'dom', nodes: snapshotOf('<p>Read <a href="/guide">the guide</a>.</p>') }, defaults).text).toBe('Read the guide.');
  });

  it('does not track without being asked, or for very long texts', () => {
    expect(plain('a  b').changes).toBeUndefined();
    expect(tracked('x'.repeat(TRACK_LIMIT + 1)).changes).toBeUndefined();
    expect(tracked('x'.repeat(TRACK_LIMIT + 1)).text).toHaveLength(TRACK_LIMIT + 1);
  });

  it('gives the same text with and without tracking', () => {
    const input = '# T’s\n\n* a   b​\nc-\nd  https://e.example/?gclid=1&q=2\n\n\n\nend';
    for (const options of [{}, { lineBreaks: 'merge' as const, keepBullets: false }, { typography: true, removeMarkdown: true, collapseWhitespace: false }]) {
      expect(tracked(input, options).text).toBe(plain(input, options).text);
    }
  });

  it('describes typography fixes and Markdown removals', () => {
    expect(describeClean({ invisible: 1, trackingParams: 2, replacements: 0, rulesApplied: 0, markdown: 3, typography: 4 }, 10)).toBe(
      '10 characters · removed 2 tracking parameters, 1 invisible character and 3 Markdown marks · 4 typography fixes',
    );
  });
});
