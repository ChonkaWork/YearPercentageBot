import type { Settings } from '../core/settings';
import { isInterval, type Watch } from '../core/types';
import { watchesForPatterns } from '../core/permissions';
import { sanitizeWatches } from '../core/watch';
import { loadSettings, loadWatches, saveSettings, WATCHES_KEY } from '../storage/store';
import { byId, h, icon } from '../ui/dom';
import { INTERVAL_OPTIONS, plural } from '../ui/format';
import { ICONS } from '../ui/icons';

const els = {
  notifyChanges: byId<HTMLInputElement>('notify-changes'),
  notifyErrors: byId<HTMLInputElement>('notify-errors'),
  defaultInterval: byId<HTMLSelectElement>('default-interval'),
  sites: byId<HTMLUListElement>('sites'),
  sitesEmpty: byId<HTMLParagraphElement>('sites-empty'),
  status: byId<HTMLSpanElement>('save-status'),
  privacyIcon: byId<HTMLSpanElement>('privacy-icon'),
};
let statusTimer: number | undefined;

function render(settings: Settings): void {
  els.notifyChanges.checked = settings.notifyChanges;
  els.notifyErrors.checked = settings.notifyErrors;
  els.defaultInterval.value = String(settings.defaultIntervalMinutes);
}

async function save(patch: Partial<Settings>): Promise<void> {
  try {
    render(await saveSettings(patch));
    showStatus('Saved');
  } catch {
    showStatus("Couldn't save. Please try again.", true);
  }
}

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('text-success', !isError);
  els.status.classList.toggle('text-danger', isError);
  if (!isError) statusTimer = window.setTimeout(() => (els.status.textContent = ''), 1800);
}

/** Sites Page Watch may fetch (granted when adding watches), with how many watches use each. */
async function renderSites(watches?: Watch[]): Promise<void> {
  const [permissions, list] = await Promise.all([chrome.permissions.getAll(), watches ?? loadWatches()]);
  const origins = (permissions.origins ?? []).filter((origin) => /^https?:/.test(origin)).sort();
  els.sites.replaceChildren(
    ...origins.map((pattern) => {
      const count = watchesForPatterns(list, [pattern]).length;
      const remove = h(
        'button',
        { class: 'btn btn-sm btn-outline-danger', attrs: { type: 'button' } },
        icon(ICONS.trash),
        'Remove',
      );
      remove.addEventListener('click', async () => {
        try {
          const removed = await chrome.permissions.remove({ origins: [pattern] });
          if (!removed) throw new Error('not removed');
          showStatus(count ? `Access removed. ${plural(count, 'watch')} will stop working until you allow it again.` : 'Access removed');
        } catch {
          showStatus("This access can't be removed here.", true);
        }
        await renderSites();
      });
      return h(
        'li',
        { class: 'list-group-item site-row' },
        h('span', { class: 'site-origin', text: pattern.replace(/\/\*$/, '') }),
        h('span', { class: 'small text-body-secondary', text: count ? plural(count, 'watch') : 'unused' }),
        remove,
      );
    }),
  );
  els.sites.hidden = origins.length === 0;
  els.sitesEmpty.hidden = origins.length > 0;
}

async function init(): Promise<void> {
  els.privacyIcon.append(icon(ICONS.privacy, { class: 'text-primary' }));
  for (const option of INTERVAL_OPTIONS) els.defaultInterval.append(h('option', { text: option.label, attrs: { value: option.value } }));
  render(await loadSettings());
  await renderSites();

  els.notifyChanges.addEventListener('change', () => void save({ notifyChanges: els.notifyChanges.checked }));
  els.notifyErrors.addEventListener('change', () => void save({ notifyErrors: els.notifyErrors.checked }));
  els.defaultInterval.addEventListener('change', () => {
    const minutes = Number(els.defaultInterval.value);
    if (isInterval(minutes)) void save({ defaultIntervalMinutes: minutes });
  });
  chrome.permissions.onAdded.addListener(() => void renderSites());
  chrome.permissions.onRemoved.addListener(() => void renderSites());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WATCHES_KEY]) void renderSites(sanitizeWatches(changes[WATCHES_KEY].newValue));
  });
}

init().catch(() => showStatus("Couldn't load settings.", true));
