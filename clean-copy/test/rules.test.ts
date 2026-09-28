import { describe, expect, it } from 'vitest';
import { applyRules, emptyRule, isUnsafePattern, RULE_LIMITS, sanitizeRules, unescapeReplacement, validateRule, type Rule } from '../src/core/rules';

let next = 0;
function rule(find: string, replace = '', extra: Partial<Rule> = {}): Rule {
  return { id: `r${next++}`, enabled: true, mode: 'text', find, replace, caseSensitive: false, ...extra };
}
const regex = (find: string, replace = '', extra: Partial<Rule> = {}) => rule(find, replace, { mode: 'regex', ...extra });

describe('validateRule', () => {
  it('accepts plain text and valid regexes', () => {
    expect(validateRule(rule('Read more'))).toEqual({ ok: true });
    expect(validateRule(regex('^Sent from my \\w+$'))).toEqual({ ok: true });
    expect(validateRule(regex('(\\d{3})-(\\d{4})', '$2 $1'))).toEqual({ ok: true });
    expect(validateRule(regex('(?<year>\\d{4})', '$<year>'))).toEqual({ ok: true });
  });

  it('rejects empty, too long and invalid patterns with a message', () => {
    expect(validateRule(rule(''))).toMatchObject({ ok: false, error: 'empty' });
    expect(validateRule(rule('x'.repeat(RULE_LIMITS.maxFindLength + 1)))).toMatchObject({ ok: false, error: 'too-long' });
    expect(validateRule(rule('x', 'y'.repeat(RULE_LIMITS.maxReplaceLength + 1)))).toMatchObject({ ok: false, error: 'replace-too-long' });
    const invalid = validateRule(regex('(unclosed'));
    expect(invalid).toMatchObject({ ok: false, error: 'invalid-regex' });
    expect(!invalid.ok && invalid.message).toMatch(/not a valid regular expression/);
  });

  it('text rules may contain regex characters', () => {
    expect(validateRule(rule('(unclosed [ *'))).toEqual({ ok: true });
  });

  it('rejects references to groups that do not exist', () => {
    expect(validateRule(regex('(a)', '$2'))).toMatchObject({ ok: false, error: 'unknown-group' });
    expect(validateRule(regex('(?<a>x)', '$<b>'))).toMatchObject({ ok: false, error: 'unknown-group' });
    expect(validateRule(regex('a', '$$1 costs $&'))).toEqual({ ok: true });
  });

  it('rejects catastrophic-backtracking shapes', () => {
    expect(validateRule(regex('(a+)+$'))).toMatchObject({ ok: false, error: 'unsafe-regex' });
  });
});

describe('isUnsafePattern', () => {
  it.each(['(a+)+', '(a*)*', '(\\w+\\s?)*$', '(?:x|y+){2,}', '(.*a){3,}', '(a|a)+', '(a|ab)*c', '((a+))+', '(?<n>\\d+)+', '([a-z]+)*@'])('flags %s', (pattern) => {
    expect(isUnsafePattern(pattern)).toBe(true);
  });

  it.each(['a+b+', '(ab)+', '(abc|def)+', '\\(a+\\)+', '[(a+)]+', '(\\d{3})-(\\d{4})', '(a+)?', '(https?://)?\\S+', '^Sent from my .+$', '(?:foo|bar)\\s+'])('allows %s', (pattern) => {
    expect(isUnsafePattern(pattern)).toBe(false);
  });
});

describe('applyRules', () => {
  it('applies rules in order, after each other', () => {
    const result = applyRules('Hello World', [rule('world', 'there'), rule('there', 'you')]);
    expect(result).toMatchObject({ text: 'Hello you', replacements: 2, rulesApplied: 2, skipped: 0 });
  });

  it('text rules are literal and case-insensitive unless asked', () => {
    expect(applyRules('a.b A.B', [rule('a.b', 'x')]).text).toBe('x x');
    expect(applyRules('a.b A.B', [rule('a.b', 'x', { caseSensitive: true })]).text).toBe('x A.B');
    expect(applyRules('costs $5', [rule('$5', '$$6 $&')]).text).toBe('costs $$6 $&');
  });

  it('regex rules support groups, named groups, $& and $$', () => {
    expect(applyRules('555-0199', [regex('(\\d{3})-(\\d{4})', '$2/$1')]).text).toBe('0199/555');
    expect(applyRules('2026-09-28', [regex('(?<y>\\d{4})-(?<m>\\d\\d)-(?<d>\\d\\d)', '$<d>.$<m>.$<y>')]).text).toBe('28.09.2026');
    expect(applyRules('x', [regex('x', '[$&] $$')]).text).toBe('[x] $');
  });

  it('works line by line with ^ and $ and understands \\n in replacements', () => {
    const text = 'Hi\nSent from my iPhone\nBye';
    expect(applyRules(text, [regex('^Sent from my \\w+$\\n?', '')]).text).toBe('Hi\nBye');
    expect(applyRules('a; b; c', [rule('; ', '\\n')]).text).toBe('a\nb\nc');
    expect(unescapeReplacement('a\\tb\\\\n\\x')).toBe('a\tb\\n\\x');
  });

  it('handles empty matches without looping forever', () => {
    expect(applyRules('abc', [regex('x*', '-')]).text).toBe('-a-b-c-');
    expect(applyRules('ab', [regex('^', '> ')]).text).toBe('> ab');
  });

  it('skips disabled and invalid rules', () => {
    const result = applyRules('aaa', [rule('a', 'b', { enabled: false }), regex('(', 'x'), regex('(a+)+', 'x'), rule('', 'x'), rule('a', 'c')]);
    expect(result).toMatchObject({ text: 'ccc', skipped: 4, rulesApplied: 1 });
  });

  it('counts a rule that matches but changes nothing as not applied', () => {
    expect(applyRules('abc', [rule('b', 'b')])).toMatchObject({ text: 'abc', replacements: 1, rulesApplied: 0 });
  });

  it('stops at the time budget and keeps the work done so far', () => {
    let clock = 0;
    const now = () => (clock += 10);
    const result = applyRules('a a a a a a a a a a', [rule('a', 'b'), rule('b', 'c')], { now, timeBudgetMs: 35 });
    expect(result.stopped).toBe('time');
    expect(result.text.startsWith('b b b')).toBe(true);
    expect(result.text).not.toContain('c');
    expect(result.text.length).toBe('a a a a a a a a a a'.length);
  });

  it('stops at the match cap', () => {
    const result = applyRules('aaaaaaaaaa', [rule('a', 'b')], { maxMatches: 4 });
    expect(result).toMatchObject({ text: 'bbbbaaaaaa', stopped: 'matches' });
  });

  it('refuses to grow the text past the output limit', () => {
    const input = 'x'.repeat(100_000);
    const result = applyRules(input, [rule('x', 'y'.repeat(100))]);
    expect(result.stopped).toBe('output');
    expect(result.text).toBe(input);
  });

  it('skips rules on huge input', () => {
    const input = 'a'.repeat(RULE_LIMITS.maxInputLength + 1);
    expect(applyRules(input, [rule('a', 'b')])).toMatchObject({ stopped: 'input', replacements: 0 });
  });

  it('only uses the first maxRules rules', () => {
    const rules = Array.from({ length: RULE_LIMITS.maxRules + 2 }, () => rule('a', 'a'));
    expect(applyRules('a', rules).skipped).toBe(2);
  });

  it('keeps emoji and other scripts intact', () => {
    expect(applyRules('Привіт 👋🏽 світ', [rule('світ', 'world')]).text).toBe('Привіт 👋🏽 world');
  });
});

describe('sanitizeRules', () => {
  it('drops malformed entries, fixes fields and clamps lengths', () => {
    const rules = sanitizeRules([
      { id: 'a', find: 'x', replace: 'y', mode: 'regex', caseSensitive: true, enabled: false },
      null,
      'nope',
      { id: 'a', find: 'dup id' },
      { id: '<script>', find: 'z'.repeat(1000), replace: 5, mode: 'weird' },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ id: 'a', find: 'x', replace: 'y', mode: 'regex', caseSensitive: true, enabled: false });
    expect(rules[1]?.id).not.toBe('a');
    expect(rules[2]).toMatchObject({ mode: 'text', replace: '', enabled: true, caseSensitive: false });
    expect(rules[2]?.find).toHaveLength(RULE_LIMITS.maxFindLength);
    expect(rules[2]?.id).toMatch(/^[\w-]+$/);
    expect(sanitizeRules({})).toEqual([]);
  });

  it('creates empty rules with unique ids', () => {
    expect(emptyRule().id).not.toBe(emptyRule().id);
  });
});
