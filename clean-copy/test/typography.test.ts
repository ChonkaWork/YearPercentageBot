import { describe, expect, it } from 'vitest';
import { applyEditsToText } from '../src/core/changes';
import { typographyStep } from '../src/core/typography';

describe('typography cleanup', () => {
  it('straightens quotes, spells out ellipses and turns special spaces into spaces', () => {
    const input = '“It’s done…” she said ‘twice’. 10 km and „quoted“';
    const step = typographyStep(input);
    expect(step.text).toBe('"It\'s done..." she said \'twice\'. 10 km and "quoted"');
    expect(applyEditsToText(input, step.edits)).toBe(step.text);
    expect(step.count).toBe(9);
  });

  it('turns en dashes into hyphens and em dashes into " - ", using the spaces already there', () => {
    expect(typographyStep('pages 10–12').text).toBe('pages 10-12');
    expect(typographyStep('fast—really fast').text).toBe('fast - really fast');
    expect(typographyStep('fast — really fast').text).toBe('fast - really fast');
    expect(typographyStep('fast — really').text).toBe('fast - really');
    expect(typographyStep('— quoted line\nends with—').text).toBe('- quoted line\nends with -');
    // Only the dash is reported when the spaces stay.
    expect(typographyStep('a — b').edits).toEqual([{ start: 2, end: 3, insert: '-', kind: 'typography' }]);
  });

  it('can keep dashes', () => {
    const step = typographyStep('10–12 — “ok”', 'keep');
    expect(step.text).toBe('10–12 — "ok"');
    expect(step.count).toBe(2);
  });

  it('leaves plain text alone', () => {
    const text = 'Plain "text" - with \'quotes\'...';
    expect(typographyStep(text)).toEqual({ text, edits: [], count: 0 });
  });
});
