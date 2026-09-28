import { hasFeature, INTERVAL_MESSAGE, isEarlyAccess, isIntervalAllowed, PRO_PRICE, type Plan } from '../core/plan';
import { formatClock, parseClock, type QuietHours, type Settings } from '../core/settings';
import { exportFileName, exportWatches, importSummary, parseImportFile, planImport, type ExportedWatch, type ImportIssue } from '../core/transfer';
import { isInterval, type Watch } from '../core/types';
import { watchesForPatterns } from '../core/permissions';
import { hostLabel } from '../core/url';
import { sanitizeWatches } from '../core/watch';
import type { ImportResponse } from '../platform/messages';
import { loadPlan, loadSettings, loadWatches, planChanged, saveSettings, WATCHES_KEY } from '../storage/store';
import { playChime } from '../ui/chime';
import { byId, h, icon } from '../ui/dom';
import { INTERVAL_OPTIONS, plural, proBadge } from '../ui/format';
import { ICONS } from '../ui/icons';

const els = {
  notifyChanges: byId<HTMLInputElement>('notify-changes'),
  notifyErrors: byId<HTMLInputElement>('notify-errors'),
  sound: byId<HTMLInputElement>('sound'),
  testSound: byId<HTMLButtonElement>('test-sound'),
  exportButton: byId<HTMLButtonElement>('export'),
  importLabel: byId<HTMLLabelElement>('import-label'),
  importFile: byId<HTMLInputElement>('import-file'),
  exportStatus: byId<HTMLSpanElement>('export-status'),
  importResult: byId<HTMLDivElement>('import-result'),
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
  ['Checks every 1, 5, 15 or 30 minutes', 'Free checks from every hour.'],
  ['Number, price and keyword rules', 'Only hear about the part of a change you care about.'],
  ['“The price drops below” alerts', 'Set a target like $100; currency-aware.'],
  ['“Lowest in 30 days” alerts', 'Hear about a new low, not every small move.'],
  ['Full price history', 'Every checked value in the chart; free shows the last 7 days.'],
  ['Quiet hours', 'Hold notifications at night and get one summary in the morning.'],
] as const;

function render(next: Settings): void {
  settings = next;
  els.notifyChanges.checked = next.notifyChanges;
  els.notifyErrors.checked = next.notifyErrors;
  els.sound.checked = next.sound;
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
  // Built from what's stored when this save runs, not from the page's copy: the switch and the
  // two times are often changed in quick succession.
  void save((current) => ({ quietHours: { ...current.quietHours, ...patch } }));
}

function onTimeChange(input: HTMLInputElement, key: 'start' | 'end'): void {
  const minutes = parseClock(input.value);
  if (minutes === null) {
    showStatus('Enter a time like 22:00.', true);
    return;
  }
  saveQuiet({ [key]: minutes });
}

// Saves are read-modify-write: run them one at a time so quick changes can't overwrite each other.
let saving: Promise<unknown> = Promise.resolve();

function save(patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<void> {
  const run = saving.then(async () => {
    try {
      render(await saveSettings(typeof patch === 'function' ? patch(await loadSettings()) : patch));
      showStatus('Saved');
    } catch {
      showStatus("Couldn't save. Please try again.", true);
    }
  });
  saving = run;
  return run;
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

// --- Sound -------------------------------------------------------------------------------------

async function testSound(): Promise<void> {
  els.testSound.disabled = true;
  els.testSound.replaceChildren(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), 'Playing…');
  try {
    await playChime();
  } catch {
    showStatus("Couldn't play the sound in this browser.", true);
  }
  els.testSound.disabled = false;
  els.testSound.replaceChildren(icon(ICONS.soundOn), 'Play a test sound');
}

// --- Export and import ---------------------------------------------------------------------------

async function exportAll(): Promise<void> {
  const watches = await loadWatches();
  if (watches.length === 0) {
    els.exportStatus.textContent = 'No watches to export yet.';
    return;
  }
  const now = new Date();
  const blob = new Blob([`${JSON.stringify(exportWatches(watches, now.getTime()), null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { attrs: { href: url, download: exportFileName(now) } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  els.exportStatus.textContent = `Exported ${plural(watches.length, 'watch')} to ${exportFileName(now)}.`;
}

function resultAlert(tone: 'success' | 'danger' | 'warning', ...content: (Node | string)[]): HTMLElement {
  const glyph = tone === 'success' ? ICONS.success : tone === 'warning' ? ICONS.warning : ICONS.danger;
  return h(
    'div',
    { class: `alert alert-${tone} small d-flex gap-2 mb-0`, attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
    icon(glyph, { class: 'mt-1' }),
    h('div', { class: 'min-w-0' }, ...content),
  );
}

function showImportResult(...children: Node[]): void {
  els.importResult.hidden = children.length === 0;
  els.importResult.replaceChildren(...children);
}

function issueList(invalid: readonly ImportIssue[]): HTMLElement | null {
  if (invalid.length === 0) return null;
  const shown = invalid.slice(0, 5);
  return h(
    'ul',
    { class: 'import-issues mb-0' },
    ...shown.map((issue) => h('li', { text: `Entry ${issue.entry}: ${issue.reason}` })),
    invalid.length > shown.length ? h('li', { text: `…and ${invalid.length - shown.length} more` }) : null,
  );
}

async function previewImport(file: File): Promise<void> {
  els.importFile.value = '';
  let text: string;
  try {
    text = await file.text();
  } catch {
    showImportResult(resultAlert('danger', "Couldn't read this file."));
    return;
  }
  const parsed = parseImportFile(text);
  if (!parsed.ok) {
    showImportResult(resultAlert('danger', parsed.message));
    return;
  }
  const existing = await loadWatches();
  const planned = planImport(parsed.watches, existing, plan);
  const sites = [...new Set(planned.add.map((watch) => hostLabel(watch.url)))];
  const needAccess: string[] = [];
  for (const origin of planned.origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }).catch(() => false))) needAccess.push(origin);
  }

  const facts: HTMLElement[] = [];
  if (planned.add.length) facts.push(h('li', { text: `${plural(planned.add.length, 'new watch')} on ${sites.slice(0, 3).join(', ')}${sites.length > 3 ? ` and ${plural(sites.length - 3, 'more site')}` : ''}` }));
  if (planned.duplicates) facts.push(h('li', { text: `${plural(planned.duplicates, 'watch')} you already have (left out)` }));
  if (planned.adapted) facts.push(h('li', {}, proBadge(), ` ${planned.adapted} set to free options: their rule or interval is part of Pro`));
  if (planned.overLimit) facts.push(h('li', { text: `${planned.overLimit} over the watch limit (left out)` }));
  if (parsed.invalid.length) facts.push(h('li', { text: `${plural(parsed.invalid.length, 'entry')} that ${parsed.invalid.length === 1 ? "isn't" : "aren't"} a valid watch (left out):` }, issueList(parsed.invalid) ?? ''));

  const heading = h('div', { class: 'fw-semibold mb-1', text: `${file.name}: ${plural(parsed.watches.length + parsed.invalid.length, 'entry')}` });
  const list = h('ul', { class: 'import-facts mb-2' }, ...facts);
  const box = h('div', { class: 'import-preview' }, heading, list);
  if (planned.add.length === 0) {
    box.append(h('p', { class: 'small text-body-secondary mb-2', text: 'Nothing new to import.' }));
    box.append(h('button', { class: 'btn btn-sm btn-outline-secondary', text: 'Close', attrs: { type: 'button' }, on: { click: () => showImportResult() } }));
    showImportResult(box);
    return;
  }
  if (needAccess.length) {
    box.append(
      h(
        'p',
        { class: 'small text-body-secondary d-flex gap-1 mb-2' },
        icon(ICONS.privacy, { class: 'mt-1' }),
        h('span', { text: `Chrome will ask to let Page Watch read ${plural(needAccess.length, 'site')} (${needAccess.map((origin) => hostLabel(origin)).join(', ')}). It's only used to check the pages you watch there.` }),
      ),
    );
  }
  const confirm = h('button', { class: 'btn btn-sm btn-primary', attrs: { type: 'button' } }, icon(ICONS.upload), `Import ${plural(planned.add.length, 'watch')}`);
  const cancel = h('button', { class: 'btn btn-sm btn-outline-secondary', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => showImportResult() } });
  confirm.addEventListener('click', () => void runImport(parsed.watches, parsed.invalid.length, needAccess, confirm, cancel));
  box.append(h('div', { class: 'd-flex gap-2' }, confirm, cancel));
  showImportResult(box);
  confirm.focus();
}

async function runImport(entries: ExportedWatch[], invalid: number, needAccess: string[], confirm: HTMLButtonElement, cancel: HTMLButtonElement): Promise<void> {
  // Asked inside the click: Chrome only shows permission prompts for a user gesture.
  const access = needAccess.length ? chrome.permissions.request({ origins: needAccess }).catch(() => false) : Promise.resolve(true);
  confirm.disabled = cancel.disabled = true;
  confirm.replaceChildren(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), 'Importing…');
  const granted = await access;
  if (!granted) {
    showImportResult(resultAlert('danger', 'Nothing was imported: Page Watch needs access to those sites to check them. Try again and choose Allow when Chrome asks.'));
    return;
  }
  const response = (await chrome.runtime.sendMessage({ type: 'pw/import', entries }).catch(() => undefined)) as ImportResponse | undefined;
  if (!response?.ok) {
    showImportResult(resultAlert('danger', response?.message ?? "Page Watch didn't respond. Please try again."));
    return;
  }
  const result = { ...response.result, invalid };
  const summary = importSummary(result, plan);
  showImportResult(
    resultAlert(
      result.added ? 'success' : 'warning',
      h('div', { text: summary }),
      result.added ? h('div', { class: 'mt-1 opacity-75', text: 'Each one is checked now to take its starting point. Open Page Watch from the toolbar to see them.' }) : '',
    ),
  );
}

async function init(): Promise<void> {
  els.privacyIcon.append(icon(ICONS.privacy, { class: 'text-primary' }));
  els.testSound.append(icon(ICONS.soundOn), 'Play a test sound');
  els.exportButton.append(icon(ICONS.download), 'Export watches');
  els.importLabel.append(icon(ICONS.upload), 'Import…');
  for (const option of INTERVAL_OPTIONS) els.defaultInterval.append(h('option', { text: option.label, attrs: { value: option.value } }));
  plan = await loadPlan();
  renderPlan();
  render(await loadSettings());
  await renderSites();
  if (location.hash === '#about-pro') showAboutPro();
  window.addEventListener('hashchange', () => location.hash === '#about-pro' && showAboutPro());

  els.notifyChanges.addEventListener('change', () => void save({ notifyChanges: els.notifyChanges.checked }));
  els.notifyErrors.addEventListener('change', () => void save({ notifyErrors: els.notifyErrors.checked }));
  els.sound.addEventListener('change', () => void save({ sound: els.sound.checked }));
  els.testSound.addEventListener('click', () => void testSound());
  els.exportButton.addEventListener('click', () => void exportAll().catch(() => (els.exportStatus.textContent = "Couldn't export. Please try again.")));
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files?.[0];
    if (file) void previewImport(file);
  });
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
