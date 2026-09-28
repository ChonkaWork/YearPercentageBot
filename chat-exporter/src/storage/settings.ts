import { DEFAULT_EXPORT_OPTIONS, sanitizeExportOptions, type ExportOptions } from '../export/options';

/** Settings live in chrome.storage.local. Nothing is synced. */

export interface Settings {
  /** Show the Export button on ChatGPT and Claude pages. */
  showButton: boolean;
  /** Pro export options. Kept as they are when the plan doesn't include them (just not applied). */
  exportOptions: ExportOptions;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ showButton: true, exportOptions: DEFAULT_EXPORT_OPTIONS });

const KEY = 'settings';

export function sanitizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    showButton: typeof input.showButton === 'boolean' ? input.showButton : DEFAULT_SETTINGS.showButton,
    exportOptions: sanitizeExportOptions(input.exportOptions),
  };
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(KEY);
  return sanitizeSettings(data[KEY]);
}

/** Throws when storage is unavailable, so callers can tell the user the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) listener(sanitizeSettings(changes[KEY].newValue));
  });
}
