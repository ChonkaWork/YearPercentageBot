import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SITE_SPEEDS } from '../src/core/memory';

/** In-memory chrome.storage.local, async like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  const local = {
    async get(keys: string | string[] | null) {
      await tick();
      if (keys === null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(items: Record<string, unknown>) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      await tick();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  vi.stubGlobal('chrome', { storage: { local } });
  return data;
}

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('saves sanitized settings and merges patches', async () => {
    const data = installFakeChrome();
    const { loadSettings, saveSettings } = await import('../src/storage/store');
    expect((await loadSettings()).step).toBe(0.1);
    await saveSettings({ step: 9, blocklist: ['https://www.Vimeo.com/x'] });
    const saved = await saveSettings({ includeAudio: true });
    expect(saved).toMatchObject({ step: 2, includeAudio: true, blocklist: ['vimeo.com'] });
    expect(data.settings).toEqual(saved);
  });

  it('remembers the global speed, and the site speed in per-site mode', async () => {
    const data = installFakeChrome();
    const { loadRememberedSpeeds, saveRememberedSpeed } = await import('../src/storage/store');
    await saveRememberedSpeed(1.5, 'youtube.com', false, false);
    expect(data['speed:global']).toBe(1.5);
    expect(data['speed:site:youtube.com']).toBeUndefined();
    await saveRememberedSpeed(2, 'youtube.com', true, true);
    const remembered = await loadRememberedSpeeds('youtube.com');
    expect(remembered.global).toBe(2);
    expect(remembered.site?.speed).toBe(2);
    expect((await loadRememberedSpeeds('')).site).toBeNull();
  });

  it('keeps per-site entries bounded', async () => {
    const data = installFakeChrome();
    for (let i = 0; i < MAX_SITE_SPEEDS; i += 1) data[`speed:site:site${i}.com`] = { speed: 1.5, at: i + 1 };
    const { saveRememberedSpeed } = await import('../src/storage/store');
    await saveRememberedSpeed(2, 'newest.com', true, true);
    const sites = Object.keys(data).filter((key) => key.startsWith('speed:site:'));
    expect(sites).toHaveLength(MAX_SITE_SPEEDS);
    expect(data['speed:site:site0.com']).toBeUndefined();
    expect(data['speed:site:newest.com']).toBeDefined();
  });

  it('forgets only remembered speeds', async () => {
    const data = installFakeChrome();
    Object.assign(data, { settings: { step: 0.2 }, 'speed:global': 1.5, 'speed:site:a.com': { speed: 2, at: 1 }, 'speed:site:b.com': { speed: 3, at: 2 } });
    const { clearRememberedSpeeds, countSiteSpeeds } = await import('../src/storage/store');
    expect(await countSiteSpeeds()).toBe(2);
    expect(await clearRememberedSpeeds()).toBe(2);
    expect(Object.keys(data)).toEqual(['settings']);
  });

  it('reads the plan defensively; early access includes Pro features', async () => {
    const data = installFakeChrome();
    const { can, isAccessChange, loadAccess } = await import('../src/storage/store');
    expect(await loadAccess()).toEqual({ plan: 'free', earlyAccess: true });
    data.plan = 'lifetime';
    expect((await loadAccess()).plan).toBe('free');
    data.plan = 'pro';
    expect((await loadAccess()).plan).toBe('pro');
    // The e2e override is compiled out of real builds.
    data['e2e:earlyAccess'] = false;
    expect((await loadAccess()).earlyAccess).toBe(true);
    expect(isAccessChange({ plan: {} })).toBe(true);
    expect(isAccessChange({ 'e2e:earlyAccess': {} })).toBe(false);
    expect(can({ plan: 'free', earlyAccess: true }, 'site-defaults')).toBe(true);
    expect(can({ plan: 'free', earlyAccess: false }, 'site-defaults')).toBe(false);
    expect(can({ plan: 'pro', earlyAccess: false }, 'custom-presets')).toBe(true);
  });
});
