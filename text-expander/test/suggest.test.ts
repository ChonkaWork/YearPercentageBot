import { describe, expect, it } from 'vitest';
import { hasTrigger, MAX_QUERY, MAX_SUGGESTIONS, queryCandidates, rankSuggestions, suggest, triggerChars, type QueryCandidate } from '../src/core/suggest';

const item = (abbreviation: string, label = '', id = abbreviation) => ({ id, abbreviation, label });
const library = [
  item(';meet', 'Meeting request'),
  item(';me', 'My email'),
  item(';sig', 'Email signature'),
  item(';ty', 'Thanks'),
  item(';Mobile', 'Phone number'),
  item('/todo', 'Task list'),
  item('brb', 'Be right back'),
];
const triggers = triggerChars(library.map((entry) => entry.abbreviation));
const abbreviations = (text: string, complete = true, usage = {}) => suggest(library, text, triggers, complete, usage)?.suggestions.map((entry) => entry.item.abbreviation) ?? null;
const at = (text: string, wordStart = true): QueryCandidate => ({ text, start: 0, wordStart });

describe('triggerChars', () => {
  it('collects the first character of symbol-prefixed abbreviations only', () => {
    expect([...triggers].sort()).toEqual(['/', ';']);
    expect(triggerChars(['brb', 'x1', 'ünter'])).toEqual(new Set());
    expect(triggerChars(['👍ok', '::x'])).toEqual(new Set(['👍', ':']));
  });

  it('detects trigger characters in typed text', () => {
    expect(hasTrigger(';', triggers)).toBe(true);
    expect(hasTrigger('a;', triggers)).toBe(true);
    expect(hasTrigger('abc', triggers)).toBe(false);
    expect(hasTrigger(null, triggers)).toBe(false);
    expect(hasTrigger(';', new Set())).toBe(false);
  });
});

describe('queryCandidates', () => {
  it('finds the query in the current word, longest first', () => {
    expect(queryCandidates('Hello ;me', triggers, true)).toEqual([{ text: ';me', start: 6, wordStart: true }]);
    expect(queryCandidates(';me', triggers, true)).toEqual([{ text: ';me', start: 0, wordStart: true }]);
    expect(queryCandidates('word;me', triggers, true)).toEqual([{ text: ';me', start: 4, wordStart: false }]);
    expect(queryCandidates('a/b;c', triggers, true).map((candidate) => candidate.text)).toEqual(['/b;c', ';c']);
  });

  it('stops at whitespace and ignores words without a trigger', () => {
    expect(queryCandidates(';me ', triggers, true)).toEqual([]);
    expect(queryCandidates(';me\nhello', triggers, true)).toEqual([]);
    expect(queryCandidates('plain words', triggers, true)).toEqual([]);
    expect(queryCandidates('', triggers, true)).toEqual([]);
  });

  it("doesn't know whether a cut-off text starts a word", () => {
    // Only the last characters were read: the first one only tells what comes before.
    expect(queryCandidates('x;me', triggers, false)).toEqual([{ text: ';me', start: 1, wordStart: false }]);
    expect(queryCandidates(' ;me', triggers, false)).toEqual([{ text: ';me', start: 1, wordStart: true }]);
    expect(queryCandidates(';me', triggers, false)).toEqual([]);
  });

  it('looks back at most MAX_QUERY characters', () => {
    const long = `;${'x'.repeat(MAX_QUERY)}`;
    expect(queryCandidates(long, triggers, true)).toEqual([]);
    expect(queryCandidates(`${'x'.repeat(100)};me`, triggers, true)).toEqual([{ text: ';me', start: 100, wordStart: false }]);
  });

  it('handles characters outside the BMP', () => {
    const emoji = triggerChars(['👍ok']);
    expect(queryCandidates('hi 👍o', emoji, true)).toEqual([{ text: '👍o', start: 3, wordStart: true }]);
  });
});

describe('rankSuggestions', () => {
  it('puts the exact abbreviation first, then prefixes, then case-insensitive prefixes', () => {
    expect(rankSuggestions(library, at(';me')).map((entry) => entry.item.abbreviation)).toEqual([';me', ';meet']);
    expect(rankSuggestions(library, at(';m')).map((entry) => entry.item.abbreviation)).toEqual([';me', ';meet', ';Mobile']);
    expect(rankSuggestions(library, at(';M')).map((entry) => entry.item.abbreviation)).toEqual([';Mobile', ';me', ';meet']);
  });

  it('then matches words of the label', () => {
    const ranked = rankSuggestions(library, at(';thank'));
    expect(ranked).toEqual([{ item: library[3], by: 'name' }]);
    expect(rankSuggestions(library, at(';email')).map((entry) => entry.item.abbreviation)).toEqual([';me', ';sig']);
    expect(rankSuggestions(library, at(';sig')).map((entry) => [entry.item.abbreviation, entry.by])).toEqual([[';sig', 'abbreviation']]);
    // Words start matches only: "ail" is inside "email", not the start of a word.
    expect(rankSuggestions(library, at(';ail'))).toEqual([]);
  });

  it('needs two letters for a label match and keeps apostrophes inside words', () => {
    const labels = [item(';x', 'Tell me more'), item(';d', "Today's date")];
    expect(rankSuggestions(labels, at(';m'))).toEqual([]);
    expect(rankSuggestions(labels, at(';mo')).map((entry) => entry.item.abbreviation)).toEqual([';x']);
    expect(rankSuggestions(labels, at(';s'))).toEqual([]);
    expect(rankSuggestions(labels, at(';today'))).toEqual([{ item: labels[1], by: 'name' }]);
  });

  it('lists everything behind a lone trigger, but only at the start of a word', () => {
    expect(rankSuggestions(library, at(';')).map((entry) => entry.item.abbreviation)).toEqual([';me', ';meet', ';Mobile', ';sig', ';ty']);
    expect(rankSuggestions(library, at(';', false))).toEqual([]);
    expect(rankSuggestions(library, at('/')).map((entry) => entry.item.abbreviation)).toEqual(['/todo']);
  });

  it('in the middle of a word only matches abbreviations', () => {
    expect(rankSuggestions(library, at(';m', false)).map((entry) => entry.item.abbreviation)).toEqual([';me', ';meet', ';Mobile']);
    expect(rankSuggestions(library, at(';thank', false))).toEqual([]);
  });

  it('orders a group by use, then alphabetically', () => {
    const usage = { ';ty': { count: 9, lastUsed: 5 }, ';sig': { count: 9, lastUsed: 7 }, ';meet': { count: 2, lastUsed: 1 } };
    expect(rankSuggestions(library, at(';'), usage).map((entry) => entry.item.abbreviation)).toEqual([';sig', ';ty', ';meet', ';me', ';Mobile']);
    // The exact match stays first whatever the counts.
    expect(rankSuggestions(library, at(';me'), usage).map((entry) => entry.item.abbreviation)).toEqual([';me', ';meet']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 100 }, (_, i) => item(`;s${i}`));
    expect(rankSuggestions(many, at(';s'))).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe('suggest', () => {
  it('uses the longest query that has suggestions', () => {
    expect(abbreviations('Hi ;me')).toEqual([';me', ';meet']);
    expect(abbreviations('a/b;me')).toEqual([';me', ';meet']);
    // Abbreviations first, then labels ("Thanks").
    expect(abbreviations('Notes /th')).toEqual([';ty']);
    expect(abbreviations('Notes /t')).toEqual(['/todo']);
    expect(abbreviations('Notes /ta')).toEqual(['/todo']);
  });

  it('returns null when nothing matches', () => {
    expect(abbreviations('Hi ;zz')).toBe(null);
    expect(abbreviations('Hi there')).toBe(null);
    expect(abbreviations('brb')).toBe(null);
    expect(abbreviations('word;')).toBe(null);
    expect(suggest(library, ';me', new Set(), true)).toBe(null);
  });

  it('reports where the query starts', () => {
    expect(suggest(library, 'Hi ;me', triggers, true)?.query).toEqual({ text: ';me', start: 3, wordStart: true });
  });
});
