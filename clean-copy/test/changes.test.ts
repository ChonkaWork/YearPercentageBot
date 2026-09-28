import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  applyEditsToText,
  changeKinds,
  fallbackEdits,
  invisibleName,
  limitSegments,
  normalizeEdits,
  replacementEdit,
  resultText,
  sanitizeSegments,
  segmentsOf,
  sourceText,
  startTracking,
  track,
  type Edit,
  type Segment,
} from '../src/core/changes';

describe('applyEdits: composing the edits of several steps', () => {
  it('marks removed text, adds replacements after what they replace, keeps the rest', () => {
    const segments = applyEdits(segmentsOf('Hello   world?utm=1'), [
      { start: 6, end: 8, kind: 'whitespace' },
      { start: 13, end: 19, kind: 'tracking' },
      { start: 0, end: 1, insert: 'J', kind: 'rule' },
    ]);
    expect(segments).toEqual([
      { text: 'H', op: 'del', kind: 'rule' },
      { text: 'J', op: 'ins', kind: 'rule' },
      { text: 'ello ' },
      { text: '  ', op: 'del', kind: 'whitespace' },
      { text: 'world' },
      { text: '?utm=1', op: 'del', kind: 'tracking' },
    ]);
    expect(resultText(segments)).toBe('Jello world');
    expect(sourceText(segments)).toBe('Hello   world?utm=1');
  });

  it('uses the coordinates of the current cleaned text, skipping what earlier steps removed', () => {
    let segments = applyEdits(segmentsOf('a​b c'), [{ start: 1, end: 2, kind: 'invisible' }]);
    // "ab c": remove the space (index 2 of the cleaned text), insert a newline.
    segments = applyEdits(segments, [{ start: 2, end: 3, insert: '\n', kind: 'line-break' }]);
    expect(segments).toEqual([
      { text: 'a' },
      { text: '​', op: 'del', kind: 'invisible' },
      { text: 'b' },
      { text: ' ', op: 'del', kind: 'line-break' },
      { text: '\n', op: 'ins', kind: 'line-break' },
      { text: 'c' },
    ]);
  });

  it('drops text an earlier step added when a later step removes it (it never was in the source)', () => {
    let segments = applyEdits(segmentsOf('a—b'), [{ start: 1, end: 2, insert: ' - ', kind: 'typography' }]);
    expect(resultText(segments)).toBe('a - b');
    segments = applyEdits(segments, [{ start: 3, end: 4, kind: 'whitespace' }]);
    expect(segments).toEqual([
      { text: 'a' },
      { text: '—', op: 'del', kind: 'typography' },
      { text: ' -', op: 'ins', kind: 'typography' },
      { text: 'b' },
    ]);
    expect(sourceText(segments)).toBe('a—b');
  });

  it('handles edits that span several runs, insertions at the edges and empty texts', () => {
    const start = applyEdits(segmentsOf('abcdef'), [{ start: 2, end: 3, kind: 'invisible' }]);
    const spanning = applyEdits(start, [{ start: 1, end: 4, insert: 'X', kind: 'rule' }]);
    expect(resultText(spanning)).toBe('aXf');
    expect(sourceText(spanning)).toBe('abcdef');
    expect(spanning.filter((segment) => segment.op === 'del').map((segment) => segment.text)).toEqual(['b', 'c', 'de']);
    const edges = applyEdits(segmentsOf('mid'), [
      { start: 0, end: 0, insert: '<', kind: 'rule' },
      { start: 3, end: 3, insert: '>', kind: 'rule' },
    ]);
    expect(resultText(edges)).toBe('<mid>');
    expect(resultText(applyEdits([], [{ start: 0, end: 0, insert: 'new', kind: 'rule' }]))).toBe('new');
    expect(applyEdits(segmentsOf('same'), [])).toEqual([{ text: 'same' }]);
  });

  it('normalizes edits: sorted, clipped, no overlaps, no no-ops', () => {
    const edits: Edit[] = [
      { start: 5, end: 9, kind: 'rule' },
      { start: 1, end: 3, kind: 'whitespace' },
      { start: 2, end: 4, kind: 'bullet' },
      { start: 4, end: 4, kind: 'rule' },
      { start: 20, end: 30, insert: '!', kind: 'rule' },
    ];
    expect(normalizeEdits(edits, 10)).toEqual([
      { start: 1, end: 3, kind: 'whitespace' },
      { start: 3, end: 4, kind: 'bullet' },
      { start: 5, end: 9, kind: 'rule' },
      { start: 10, end: 10, insert: '!', kind: 'rule' },
    ]);
    expect(applyEditsToText('0123456789', edits)).toBe('049!');
  });
});

describe('helpers', () => {
  it('replacementEdit keeps only the part that changes', () => {
    expect(replacementEdit(10, ' — ', ' - ', 'typography')).toEqual({ start: 11, end: 12, insert: '-', kind: 'typography' });
    expect(replacementEdit(0, 'x', 'x', 'rule')).toBeNull();
    expect(replacementEdit(0, 'abc', 'ac', 'rule')).toEqual({ start: 1, end: 2, kind: 'rule' });
    expect(fallbackEdits('keep this part', 'keep that part', 'rule')).toEqual([{ start: 7, end: 9, insert: 'at', kind: 'rule' }]);
  });

  it('track falls back to a prefix/suffix replacement when a step reports wrong edits', () => {
    const tracker = track(startTracking('one two', true), { text: 'one 2', edits: [{ start: 0, end: 1, kind: 'rule' }] }, 'rule');
    expect(tracker.text).toBe('one 2');
    expect(resultText(tracker.segments ?? [])).toBe('one 2');
    expect(sourceText(tracker.segments ?? [])).toBe('one two');
    expect(track(startTracking('x', false), { text: 'y', edits: [] }, 'rule')).toEqual({ text: 'y', segments: null });
  });

  it('lists the kinds present, limits long texts, names invisible characters', () => {
    const segments: Segment[] = [{ text: 'a' }, { text: '?x=1', op: 'del', kind: 'tracking' }, { text: '​', op: 'del', kind: 'invisible' }];
    expect(changeKinds(segments)).toEqual(['invisible', 'tracking']);
    expect(limitSegments([{ text: 'abcdef' }, { text: 'gh', op: 'del', kind: 'rule' }], 4)).toEqual({ segments: [{ text: 'abcd' }], truncated: true });
    expect(limitSegments([{ text: 'ab' }], 4)).toEqual({ segments: [{ text: 'ab' }], truncated: false });
    expect(invisibleName('​')).toEqual({ short: 'ZWSP', name: 'zero-width space' });
    expect(invisibleName('­').short).toBe('SHY');
    expect(invisibleName('⁢').short).toBe('INV');
  });

  it('sanitizes stored segments', () => {
    expect(sanitizeSegments([{ text: 'a' }, { text: 'b', op: 'del', kind: 'tracking' }, { text: 'c', op: 'ins', kind: 'bogus' }])).toEqual([
      { text: 'a' },
      { text: 'b', op: 'del', kind: 'tracking' },
      { text: 'c', op: 'ins', kind: 'rule' },
    ]);
    expect(sanitizeSegments('nope')).toBeNull();
    expect(sanitizeSegments([{ text: 1 }])).toBeNull();
    expect(sanitizeSegments([{ text: 'abc' }], 2)).toBeNull();
  });
});
