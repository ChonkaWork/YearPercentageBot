import { describe, expect, it } from 'vitest';
import { defaultSettings, sanitizeSettings } from '../src/core/settings';

describe('settings', () => {
  it('has calm defaults: keep line breaks and bullets, strip tracking, collapse spaces', () => {
    expect(defaultSettings()).toEqual({
      lineBreaks: 'keep',
      keepBullets: true,
      stripTracking: true,
      collapseWhitespace: true,
      autoCleanEditors: false,
      autoCleanToast: true,
    });
  });

  it('keeps valid values and falls back per field', () => {
    expect(sanitizeSettings({ lineBreaks: 'merge', keepBullets: false, stripTracking: 'yes', autoCleanEditors: true, extra: 1 })).toEqual({
      ...defaultSettings(),
      lineBreaks: 'merge',
      keepBullets: false,
      autoCleanEditors: true,
    });
    expect(sanitizeSettings(null)).toEqual(defaultSettings());
    expect(sanitizeSettings({ lineBreaks: 'wrap' }).lineBreaks).toBe('keep');
  });
});
