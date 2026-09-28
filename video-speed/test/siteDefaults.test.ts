import { describe, expect, it } from 'vitest';
import { MAX_PRESETS, MAX_SITE_DEFAULTS } from '../src/core/plan';
import {
  activePresets,
  addPreset,
  removePreset,
  removeSiteDefault,
  sanitizePresets,
  sanitizeSiteDefaults,
  siteDefaultFor,
  sortedSiteDefaults,
  upsertSiteDefault,
} from '../src/core/siteDefaults';
import { PRESET_SPEEDS } from '../src/core/speed';

describe('per-site default speeds', () => {
  it('sanitizes stored rules: normalized hosts, clamped speeds, first entry per host wins', () => {
    const rules = sanitizeSiteDefaults([
      { host: 'https://www.YouTube.com/watch?v=1', speed: 1.5 },
      { host: 'youtube.com', speed: 3 },
      { host: 'coursera.org', speed: 99 },
      { host: 'slow.example', speed: 0.01 },
      { host: 'not a host', speed: 2 },
      { host: 'nan.example', speed: Number.NaN },
      { host: 'str.example', speed: '2' },
      null,
      'vimeo.com',
    ]);
    expect(rules).toEqual([
      { host: 'youtube.com', speed: 1.5 },
      { host: 'coursera.org', speed: 16 },
      { host: 'slow.example', speed: 0.0625 },
    ]);
    for (const raw of [undefined, null, {}, 'x']) expect(sanitizeSiteDefaults(raw)).toEqual([]);
  });

  it('keeps storage bounded', () => {
    const many = Array.from({ length: MAX_SITE_DEFAULTS + 20 }, (_, i) => ({ host: `s${i}.example`, speed: 1.5 }));
    expect(sanitizeSiteDefaults(many)).toHaveLength(MAX_SITE_DEFAULTS);
  });

  it('matches subdomains, and the most specific rule wins', () => {
    const rules = [
      { host: 'example.com', speed: 1.5 },
      { host: 'video.example.com', speed: 2 },
    ];
    expect(siteDefaultFor(rules, 'example.com')?.speed).toBe(1.5);
    expect(siteDefaultFor(rules, 'www.example.com')?.speed).toBe(1.5);
    expect(siteDefaultFor(rules, 'video.example.com')?.speed).toBe(2);
    expect(siteDefaultFor(rules, 'a.video.example.com')?.speed).toBe(2);
    expect(siteDefaultFor(rules, 'notexample.com')).toBeNull();
    expect(siteDefaultFor(rules, '')).toBeNull();
    expect(siteDefaultFor([], 'example.com')).toBeNull();
  });

  it('adds, replaces and removes rules', () => {
    let rules = upsertSiteDefault([], 'www.youtube.com', 1.5);
    expect(rules).toEqual([{ host: 'youtube.com', speed: 1.5 }]);
    rules = upsertSiteDefault(rules, 'coursera.org', 1.25);
    rules = upsertSiteDefault(rules, 'YouTube.com', 1.75);
    expect(rules).toEqual([
      { host: 'youtube.com', speed: 1.75 },
      { host: 'coursera.org', speed: 1.25 },
    ]);
    expect(upsertSiteDefault(rules, '???', 2)).toEqual(rules);
    expect(upsertSiteDefault([], 'a.com', 1.234)).toEqual([{ host: 'a.com', speed: 1.23 }]);
    expect(sortedSiteDefaults(rules).map((rule) => rule.host)).toEqual(['coursera.org', 'youtube.com']);
    expect(removeSiteDefault(rules, 'youtube.com')).toEqual([{ host: 'coursera.org', speed: 1.25 }]);
  });
});

describe('custom presets', () => {
  it('sanitizes: clamped, unique, sorted, at most 8, defaults when empty or broken', () => {
    expect(sanitizePresets([2, 1, 1.0, 1.5, 99, 0])).toEqual([0.0625, 1, 1.5, 2, 16]);
    expect(sanitizePresets([1.004, 1])).toEqual([1]);
    expect(sanitizePresets(Array.from({ length: 12 }, (_, i) => 1 + i / 10))).toHaveLength(MAX_PRESETS);
    for (const raw of [undefined, null, [], ['x'], 'fast', [Number.NaN]]) expect(sanitizePresets(raw)).toEqual([...PRESET_SPEEDS]);
  });

  it('adds with clear refusals', () => {
    expect(addPreset([1, 2], 1.5)).toEqual({ ok: true, presets: [1, 1.5, 2] });
    expect(addPreset([1, 2], 20)).toEqual({ ok: true, presets: [1, 2, 16] });
    expect(addPreset([1, 2], 2)).toEqual({ ok: false, error: '2× is already a preset.' });
    expect(addPreset([1, 2], Number.NaN)).toMatchObject({ ok: false });
    expect(addPreset(PRESET_SPEEDS, 1.1)).toEqual({ ok: false, error: 'The popup has room for 8 presets. Remove one first.' });
  });

  it('removes, but keeps at least one', () => {
    expect(removePreset([1, 1.5], 1.5)).toEqual({ ok: true, presets: [1] });
    expect(removePreset([1], 1)).toEqual({ ok: false, error: 'Keep at least one preset.' });
  });

  it('the popup uses the built-in presets without the feature', () => {
    expect(activePresets([1.1, 1.3], true)).toEqual([1.1, 1.3]);
    expect(activePresets([1.1, 1.3], false)).toEqual([...PRESET_SPEEDS]);
  });
});
