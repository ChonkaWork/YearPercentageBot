import { planImport, type ImportMode, type ImportPlan } from '../core/importExport';
import {
  addDisabledSite,
  normalizeHostname,
  removeDisabledSitesFor,
  sanitizeSettings,
  type Settings,
} from '../core/settings';
import {
  hasErrors,
  LIMITS,
  normalizeDraft,
  sanitizeSnippets,
  validateDraft,
  type FieldErrors,
  type Snippet,
  type SnippetDraft,
} from '../core/snippets';
import { STARTER_SNIPPETS } from '../core/starters';
import { SETTINGS_KEY, SNIPPETS_KEY } from './keys';

/**
 * Everything lives in chrome.storage.local, in this browser only. (storage.sync allows 100 KB
 * in total and 8 KB per item, too small for a real snippet library.) Values are sanitized on
 * every read. Functions throw when storage fails so the UI can say so.
 */

export class SnippetValidationError extends Error {
  override name = 'SnippetValidationError';
  constructor(readonly errors: FieldErrors) {
    super(Object.values(errors)[0] ?? 'Invalid snippet.');
  }
}

export async function loadSnippets(): Promise<Snippet[]> {
  const data = await chrome.storage.local.get(SNIPPETS_KEY);
  return sanitizeSnippets(data[SNIPPETS_KEY]);
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(data[SETTINGS_KEY]);
}

// Writes are read-modify-write on one key; serialize them within a page so two quick
// edits can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function writeSnippets(snippets: Snippet[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [SNIPPETS_KEY]: snippets });
  } catch (error) {
    if (error instanceof Error && /quota/i.test(error.message)) {
      throw new Error('Browser storage for Snippets is full. Delete some long snippets and try again.');
    }
    throw error;
  }
}

function newId(): string {
  return crypto.randomUUID();
}

/** Creates (id null) or updates a snippet. Validates against what is stored right now. */
export function saveSnippet(input: Partial<SnippetDraft>, id: string | null): Promise<{ snippet: Snippet; snippets: Snippet[] }> {
  return serialized(async () => {
    const snippets = await loadSnippets();
    const draft = normalizeDraft(input);
    const current = id === null ? undefined : snippets.find((snippet) => snippet.id === id);
    if (id !== null && !current) throw new Error('This snippet was deleted in another window.');
    const errors = validateDraft(draft, snippets.filter((snippet) => snippet.id !== id));
    if (hasErrors(errors)) throw new SnippetValidationError(errors);
    const now = Date.now();
    let snippet: Snippet;
    let next: Snippet[];
    if (current) {
      snippet = { ...current, ...draft, updatedAt: now };
      next = snippets.map((entry) => (entry.id === id ? snippet : entry));
    } else {
      if (snippets.length >= LIMITS.snippetsMax) throw new Error(`You can have up to ${LIMITS.snippetsMax} snippets.`);
      snippet = { id: newId(), ...draft, createdAt: now, updatedAt: now };
      next = [...snippets, snippet];
    }
    await writeSnippets(next);
    return { snippet, snippets: next };
  });
}

/** Returns the deleted snippet (for undo), or null if it was already gone. */
export function deleteSnippet(id: string): Promise<Snippet | null> {
  return serialized(async () => {
    const snippets = await loadSnippets();
    const removed = snippets.find((snippet) => snippet.id === id) ?? null;
    if (removed) await writeSnippets(snippets.filter((snippet) => snippet.id !== id));
    return removed;
  });
}

/** Puts a deleted snippet back (undo). Fails if its abbreviation was taken in the meantime. */
export function restoreSnippet(snippet: Snippet): Promise<void> {
  return serialized(async () => {
    const snippets = await loadSnippets();
    if (snippets.some((entry) => entry.id === snippet.id)) return;
    const errors = validateDraft(snippet, snippets);
    if (hasErrors(errors)) throw new SnippetValidationError(errors);
    await writeSnippets([...snippets, snippet]);
  });
}

export function importSnippets(drafts: readonly SnippetDraft[], mode: ImportMode): Promise<ImportPlan> {
  return serialized(async () => {
    const plan = planImport(await loadSnippets(), drafts, mode, newId, Date.now());
    await writeSnippets(plan.snippets);
    return plan;
  });
}

/** First install only: adds the starter snippets unless something is stored already. */
export function seedStarterSnippets(): Promise<boolean> {
  return serialized(async () => {
    const data = await chrome.storage.local.get(SNIPPETS_KEY);
    if (data[SNIPPETS_KEY] !== undefined) return false;
    const now = Date.now();
    await writeSnippets(STARTER_SNIPPETS.map((draft) => ({ id: newId(), ...draft, createdAt: now, updatedAt: now })));
    return true;
  });
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return serialized(async () => {
    const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

/** Adds a site to the disable list (enabled = false) or removes every entry covering it. */
export function setSiteEnabled(hostname: string, enabled: boolean): Promise<Settings> {
  return serialized(async () => {
    const settings = await loadSettings();
    const host = normalizeHostname(hostname);
    if (!host) throw new Error(`"${hostname}" isn't a valid site.`);
    const disabledSites = enabled ? removeDisabledSitesFor(settings.disabledSites, host) : addDisabledSite(settings.disabledSites, host);
    const next = sanitizeSettings({ ...settings, disabledSites });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

export interface StoreChange {
  snippets?: Snippet[];
  settings?: Settings;
}

/** Calls back with sanitized values whenever snippets or settings change in any context. */
export function onStoreChanged(callback: (change: StoreChange) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change: StoreChange = {};
    if (SNIPPETS_KEY in changes) change.snippets = sanitizeSnippets(changes[SNIPPETS_KEY]?.newValue);
    if (SETTINGS_KEY in changes) change.settings = sanitizeSettings(changes[SETTINGS_KEY]?.newValue);
    if (change.snippets || change.settings) callback(change);
  });
}
