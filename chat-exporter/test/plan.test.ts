import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, isPlan, limitsFor, PRO_FEATURES, PRO_PRICE, proMessage, sanitizePlan, type ProFeature } from '../src/core/plan';
import { featureFor } from '../src/export/actions';

const ALL: ProFeature[] = ['json', 'pdf', 'obsidian', 'export-options'];

describe('plan seam', () => {
  it('is in early access with a $2.99 price until payments exist', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
  });

  it('sanitizes the stored plan (anything unexpected is free)', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const junk of [undefined, null, 'PRO', 1, true, {}, ['pro']]) expect(sanitizePlan(junk)).toBe('free');
    expect(isPlan('pro')).toBe(true);
    expect(isPlan('premium')).toBe(false);
  });

  it('early access unlocks every Pro feature, even on the free plan', () => {
    for (const feature of ALL) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
  });

  it('without early access, only Pro has Pro features', () => {
    for (const feature of ALL) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
  });

  it('limits: free gets Markdown and text, Pro every format and the export options', () => {
    expect(limitsFor('free', false)).toEqual({ formats: ['markdown', 'text'], exportOptions: false });
    expect(limitsFor('pro', false)).toEqual({ formats: ['markdown', 'text', 'obsidian', 'json', 'pdf'], exportOptions: true });
    expect(limitsFor('free')).toEqual(limitsFor('pro', false));
  });

  it('lists every Pro feature once for the About Pro card', () => {
    expect(PRO_FEATURES.map((item) => item.feature).sort()).toEqual([...ALL].sort());
    for (const item of PRO_FEATURES) expect(item.title && item.description).toBeTruthy();
  });

  it('maps actions to features: copy, .md and .txt are free', () => {
    expect(featureFor('copy')).toBeNull();
    expect(featureFor('markdown')).toBeNull();
    expect(featureFor('text')).toBeNull();
    expect(featureFor('obsidian')).toBe('obsidian');
    expect(featureFor('json')).toBe('json');
    expect(featureFor('pdf')).toBe('pdf');
  });

  it('explains a Pro feature calmly, with the price', () => {
    expect(proMessage('json')).toBe('JSON export is part of Pro ($2.99, one-time). Free keeps Copy as Markdown and .md / .txt downloads.');
  });
});
