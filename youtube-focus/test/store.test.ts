import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const data: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
      }),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
    },
  },
});

const store = await import('../src/storage/store');

describe('store', () => {
  beforeEach(() => {
    for (const key of Object.keys(data)) delete data[key];
  });

  it('loads defaults and sanitizes what is stored', async () => {
    expect(await store.loadSettings()).toEqual(DEFAULT_SETTINGS);
    data.settings = { enabled: 'x', hide: { comments: true } };
    const settings = await store.loadSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.hide.comments).toBe(true);
  });

  it('updates from the current value, so concurrent edits keep each other', async () => {
    await store.saveSettings({ enabled: false });
    await store.updateSettings((current) => ({ hide: { ...current.hide, comments: true } }));
    const settings = await store.loadSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.hide.comments).toBe(true);
  });

  it('reads the plan (early access in production builds, no e2e override)', async () => {
    data.plan = 'pro';
    data['e2e:earlyAccess'] = false;
    expect(await store.loadAccess()).toEqual({ plan: 'pro', earlyAccess: true });
    expect(store.isAccessChange({ plan: {} })).toBe(true);
    expect(store.isAccessChange({ 'e2e:earlyAccess': {} })).toBe(false);
    expect(store.can({ plan: 'free', earlyAccess: false }, 'schedule')).toBe(false);
  });
});
