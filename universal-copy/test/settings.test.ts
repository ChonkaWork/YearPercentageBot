import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCsvDelimiter, defaultSettings, MARKDOWN_PRESETS, matchingPreset, sanitizeSettings } from '../src/core/settings';

describe('settings', () => {
  it('picks the CSV delimiter Excel uses for the locale', () => {
    expect(defaultCsvDelimiter('en-US')).toBe(',');
    expect(defaultCsvDelimiter('uk-UA')).toBe(';');
    expect(defaultCsvDelimiter('de-DE')).toBe(';');
    expect(defaultCsvDelimiter('not a locale!!')).toBe(',');
  });

  it('falls back per field when storage holds garbage', () => {
    expect(sanitizeSettings({ shortcutFormat: 'pdf', includeLinkUrls: 'yes', bulletMarker: '*', emphasisMarker: 7, csvDelimiter: '|' }, defaultSettings('en-US'))).toEqual({
      shortcutFormat: 'text',
      includeLinkUrls: false,
      bulletMarker: '*',
      emphasisMarker: '*',
      csvDelimiter: ',',
    });
    expect(sanitizeSettings(null, defaultSettings('uk-UA')).csvDelimiter).toBe(';');
  });
});

describe('Markdown presets', () => {
  it('only set valid Markdown options, and each preset is distinct', () => {
    const combos = new Set<string>();
    for (const preset of MARKDOWN_PRESETS) {
      const applied = sanitizeSettings({ ...defaultSettings('en-US'), ...preset.values });
      expect(applied).toMatchObject(preset.values);
      combos.add(`${preset.values.bulletMarker}${preset.values.emphasisMarker}`);
    }
    expect(combos.size).toBe(MARKDOWN_PRESETS.length);
    expect(MARKDOWN_PRESETS.map((preset) => preset.label)).toEqual(['GitHub', 'Obsidian', 'Plain']);
  });

  it('recognizes the preset the options match, or none', () => {
    expect(matchingPreset(defaultSettings('en-US'))).toBe('github');
    expect(matchingPreset({ bulletMarker: '-', emphasisMarker: '_' })).toBe('obsidian');
    expect(matchingPreset({ bulletMarker: '*', emphasisMarker: '_' })).toBe('plain');
    expect(matchingPreset({ bulletMarker: '+', emphasisMarker: '*' })).toBeNull();
  });
});

/** In-memory chrome.storage. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const area = {
    async get(key: string) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
    },
    async remove(key: string) {
      delete data[key];
    },
  };
  vi.stubGlobal('chrome', { storage: { local: area, session: area } });
  return data;
}

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('saves a sanitized patch on top of the stored settings', async () => {
    const data = installFakeChrome();
    data.settings = { shortcutFormat: 'markdown' };
    const { loadSettings, saveSettings } = await import('../src/storage/store');
    expect((await loadSettings()).shortcutFormat).toBe('markdown');
    const saved = await saveSettings({ csvDelimiter: ';', bulletMarker: 'x' as never });
    expect(saved).toMatchObject({ shortcutFormat: 'markdown', csvDelimiter: ';', bulletMarker: '-' });
    expect(data.settings).toEqual(saved);
  });

  it('keeps a notice for the popup once, and ignores stale ones', async () => {
    const data = installFakeChrome();
    const { setNotice, takeNotice } = await import('../src/storage/store');
    await setNotice({ tone: 'error', title: 'No table in the selection', detail: 'Select text inside a table.' });
    expect(await takeNotice()).toMatchObject({ tone: 'error', title: 'No table in the selection' });
    expect(await takeNotice()).toBeNull();
    data.notice = { tone: 'error', title: 'Old', createdAt: Date.now() - 60 * 60 * 1000 };
    expect(await takeNotice()).toBeNull();
  });

  it('reads the stored plan sanitized, free by default, with early access on', async () => {
    const data = installFakeChrome();
    const { canUse, loadEntitlements } = await import('../src/storage/store');
    expect(await loadEntitlements()).toEqual({ plan: 'free', earlyAccess: true });
    data.plan = 'pro';
    expect(await loadEntitlements()).toEqual({ plan: 'pro', earlyAccess: true });
    data.plan = { hacked: true };
    expect((await loadEntitlements()).plan).toBe('free');
    // The e2e-only switch is compiled out of normal builds.
    data.e2eEarlyAccess = false;
    expect((await loadEntitlements()).earlyAccess).toBe(true);
    expect(canUse({ plan: 'free', earlyAccess: false }, 'download')).toBe(false);
    expect(canUse({ plan: 'pro', earlyAccess: false }, 'download')).toBe(true);
    expect(canUse({ plan: 'free', earlyAccess: true }, 'page-link')).toBe(true);
  });
});
