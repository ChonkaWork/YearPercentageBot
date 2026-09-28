import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, limitsFor, PRO_FEATURES, PRO_PRICE, sanitizePlan, upgradeMessage } from '../src/core/plan';
import { defaultCsvDelimiter, defaultSettings, sanitizeSettings } from '../src/core/settings';

describe('plan', () => {
  it('gives everyone Pro during early access', () => {
    expect(EARLY_ACCESS).toBe(true);
    for (const feature of PRO_FEATURES) expect(hasFeature('free', feature)).toBe(true);
    expect(limitsFor('free').basketTables).toBeGreaterThan(0);
  });

  it('gates Pro features once early access ends', () => {
    for (const feature of PRO_FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ basketTables: 0, basketCells: 0 });
    expect(limitsFor('pro', false)).toEqual({ basketTables: 20, basketCells: 250_000 });
  });

  it('sanitizes the stored plan', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const value of ['PRO', 'free', undefined, null, 1, {}]) expect(sanitizePlan(value)).toBe('free');
  });

  it('explains Pro calmly with the price', () => {
    expect(PRO_PRICE).toBe('$2.99');
    expect(upgradeMessage('xlsx')).toBe('Download .xlsx is part of Table Copy Pro ($2.99, one-time).');
  });
});

describe('settings', () => {
  it('defaults the CSV delimiter to ";" in comma-decimal locales', () => {
    expect(defaultCsvDelimiter('en-US')).toBe(',');
    expect(defaultCsvDelimiter('uk-UA')).toBe(';');
    expect(defaultCsvDelimiter('de-DE')).toBe(';');
    expect(defaultCsvDelimiter('fr-FR')).toBe(';');
    expect(defaultCsvDelimiter('invalid locale!!')).toBe(',');
    expect(defaultSettings('uk')).toEqual({ csvDelimiter: ';', xlsxNumbers: true, mergeSource: true, mergeLayout: 'stack' });
  });

  it('sanitizes stored settings field by field', () => {
    const defaults = defaultSettings('en-US');
    expect(sanitizeSettings(null, defaults)).toEqual(defaults);
    expect(sanitizeSettings({ csvDelimiter: ';', xlsxNumbers: false, mergeSource: 'yes', mergeLayout: 'sheets', extra: 1 }, defaults)).toEqual({
      csvDelimiter: ';',
      xlsxNumbers: false,
      mergeSource: true,
      mergeLayout: 'sheets',
    });
    expect(sanitizeSettings({ csvDelimiter: '|', mergeLayout: 'grid' }, defaults)).toEqual(defaults);
  });
});
