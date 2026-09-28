import { hasFeature, INTERVAL_MESSAGE, isEarlyAccess, isIntervalAllowed, PRO_PRICE, type Plan } from '../core/plan';
import { formatClock, parseClock, type QuietHours, type Settings } from '../core/settings';
import { isInterval, type Watch } from '../core/types';
import { watchesForPatterns } from '../core/permissions';
import { sanitizeWatches } from '../core/watch';
import { loadPlan, loadSettings, loadWatches, planChanged, saveSettings, WATCHES_KEY } from '../storage/store';
import { byId, h, icon } from '../ui/dom';
import { INTERVAL_OPTIONS, plural, proBadge } from '../ui/format';
import { ICONS } from '../ui/icons';

const els = {
  notifyChanges: byId<HTMLInputElement>('notify-changes'),
  notifyErrors: byId<HTMLInputElement>('notify-errors'),
  defaultInterval: byId<HTMLSelectElement>('default-interval'),
  sites: byId<HTMLUListElement>('sites'),
  sitesEmpty: byId<HTMLParagraphElement>('sites-empty'),
  status: byId<HTMLSpanElement>('save-status'),
  privacyIcon: byId<HTMLSpanElement>('privacy-icon'),
  intervalLocked: byId<HTMLParagraphElement>('interval-locked'),
  quietBadge: byId<HTMLSpanElement>('quiet-badge'),
  quietEnabled: byId<HTMLInputElement>('quiet-enabled'),
  quietStart: byId<HTMLInputElement>('quiet-start'),
  quietEnd: byId<HTMLInputElement>('quiet-end'),
  quietLocked: byId<HTMLParagraphElement>('quiet-locked'),
  aboutPro: byId<HTMLElement>('about-pro'),
  proBadge: byId<HTMLSpanElement>('pro-badge'),
  proStatus: byId<HTMLParagraphElement>('pro-status'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  getProNote: byId<HTMLSpanElement>('get-pro-note'),
};
let statusTimer: number | undefined;
let plan: Plan = 'free';
let settings: Settings | null = null;

const PRO_FEATURE_LIST = [
  ['Unlimited watches', 'Free keeps 3.'],
  ['Checks every 5, 15 or 30 minutes', 'Free checks from every hour.'],
  ['Number, price and keyword rules', 'Only hear about the part of a change you care about.'],
  ['“The price drops below” alerts', 'Set a target like $100; currency-aware.'],
  ['Quiet hours', 'Hold notifications at night and get one summary in the morning.'],
] as const;

function render(next: Settings): void {
  settings = next;
  els.notifyChanges.checked = next.notifyChanges;
  els.notifyErrors.checked = next.notifyErrors;
  els.defaultInterval.value = String(next.defaultIntervalMinutes);
  const quietAllowed = hasFeature(plan, 'quiet-hours');
  els.quietEnabled.checked = next.quietHours.enabled && quietAllowed;
  els.quietEnabled.disabled = !quietAllowed;
  // Don't overwrite a time the user is still typing.
  if (document.activeElement !== els.quietStart) els.quietStart.value = formatClock(next.quietHours.start);
  if (document.activeElement !== els.quietEnd) els.quietEnd.value = formatClock(next.quietHours.end);
  els.quietStart.disabled = els.quietEnd.disabled = !quietAllowed || !next.quietHours.enabled;
}

function lockedNote(target: HTMLElement, text: string | null): void {
  target.hidden = text === null;
  if (text === null) {
    target.replaceChildren();
    return;
  }
  const link = h('a', { class: 'link-primary', text: 'About Pro', attrs: { href: '#about-pro' } });
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showAboutPro();
  });
  target.replaceChildren(h('span', { class: 'd-inline-flex align-items-center gap-2 flex-wrap' }, proBadge(), h('span', { text }), link));
}

function showAboutPro(): void {
  els.aboutPro.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.aboutPro.focus({ preventScroll: true });
}

/** Plan-dependent parts: the About Pro card, PRO badges, what's locked on the free plan. */
function renderPlan(): void {
  const early = isEarlyAccess();
  const pro = plan === 'pro';
  els.proBadge.replaceChildren(proBadge());
  els.quietBadge.replaceChildren(proBadge());
  els.proPrice.textContent = PRO_PRICE;
  els.proStatus.textContent = pro
    ? 'You have Pro. Thank you!'
    : early
      ? 'Early access: every Pro feature is on for you, free.'
      : "You're on the free plan.";
  els.getPro.disabled = true;
  els.getProNote.textContent = pro ? '' : early ? 'Free during early access' : 'Not available yet';
  els.getPro.hidden = pro;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURE_LIST.map(([title, detail]) =>
      h('li', {}, icon(ICONS.check, { class: 'text-primary' }), h('span', {}, h('strong', { text: title }), ' ', h('span', { class: 'text-body-secondary', text: detail }))),
    ),
  );

  for (const option of Array.from(els.defaultInterval.options)) {
    const minutes = Number(option.value);
    const allowed = isIntervalAllowed(plan, minutes);
    const label = INTERVAL_OPTIONS.find((item) => item.value === option.value)?.label ?? option.value;
    option.disabled = !allowed;
    option.textContent = allowed ? label : `${label} · PRO`;
  }
  const lockedIntervals = Array.from(els.defaultInterval.options).some((option) => option.disabled);
  lockedNote(els.intervalLocked, lockedIntervals ? INTERVAL_MESSAGE : null);
  lockedNote(els.quietLocked, hasFeature(plan, 'quiet-hours') ? null : 'Quiet hours are part of Pro.');
  if (settings) render(settings);
}

function saveQuiet(patch: Partial<QuietHours>): void {
  if (!settings) return;
  void save({ quietHours: { ...settings.quietHours, ...patch } });
}

function onTimeChange(input: HTMLInputElement, key: 'start' | 'end'): void {
  const minutes = parseClock(input.value);
  if (minutes === null) {
    showStatus('Enter a time like 22:00.', true);
    return;
  }
  saveQuiet({ [key]: minutes });
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
  plan = await loadPlan();
  renderPlan();
  render(await loadSettings());
  await renderSites();
  if (location.hash === '#about-pro') showAboutPro();
  window.addEventListener('hashchange', () => location.hash === '#about-pro' && showAboutPro());

  els.notifyChanges.addEventListener('change', () => void save({ notifyChanges: els.notifyChanges.checked }));
  els.notifyErrors.addEventListener('change', () => void save({ notifyErrors: els.notifyErrors.checked }));
  els.defaultInterval.addEventListener('change', () => {
    const minutes = Number(els.defaultInterval.value);
    if (isInterval(minutes)) void save({ defaultIntervalMinutes: minutes });
  });
  els.quietEnabled.addEventListener('change', () => saveQuiet({ enabled: els.quietEnabled.checked }));
  els.quietStart.addEventListener('change', () => onTimeChange(els.quietStart, 'start'));
  els.quietEnd.addEventListener('change', () => onTimeChange(els.quietEnd, 'end'));
  chrome.permissions.onAdded.addListener(() => void renderSites());
  chrome.permissions.onRemoved.addListener(() => void renderSites());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WATCHES_KEY]) void renderSites(sanitizeWatches(changes[WATCHES_KEY].newValue));
    if (area === 'local' && planChanged(changes)) {
      void loadPlan().then((loaded) => {
        plan = loaded;
        renderPlan();
      });
    }
  });
}

init().catch(() => showStatus("Couldn't load settings.", true));
