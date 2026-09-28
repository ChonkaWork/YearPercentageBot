import { PRO_FEATURES, PRO_PRICE } from '../core/plan';
import { exportFilename } from '../export/formats';
import { MAX_LAST_MESSAGES, parseTags, sanitizeExportOptions, type ExportOptions } from '../export/options';
import { loadPlan, onPlanChanged, type PlanState } from '../storage/plan';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../storage/settings';
import { byId, h } from '../ui/dom';
import { icon, ICONS } from '../ui/icons';

/** Options page: the "show button" setting, Pro export options and the "About Pro" card. */

const els = {
  planBadge: byId<HTMLSpanElement>('plan-badge'),
  showButton: byId<HTMLInputElement>('show-button'),
  locked: byId<HTMLDivElement>('options-locked'),
  form: byId<HTMLFieldSetElement>('options-form'),
  includeCode: byId<HTMLInputElement>('include-code'),
  includeUser: byId<HTMLInputElement>('include-user'),
  lastEnabled: byId<HTMLInputElement>('last-enabled'),
  lastCount: byId<HTMLInputElement>('last-count'),
  template: byId<HTMLInputElement>('filename-template'),
  preview: byId<HTMLSpanElement>('filename-preview'),
  tags: byId<HTMLInputElement>('tags'),
  callouts: byId<HTMLInputElement>('callouts'),
  saveStatus: byId<HTMLParagraphElement>('save-status'),
  price: byId<HTMLSpanElement>('pro-price'),
  features: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proNote: byId<HTMLSpanElement>('pro-note'),
};

const DEFAULT_LAST = 10;
let settings: Settings = DEFAULT_SETTINGS;

function fillForm(options: ExportOptions): void {
  els.includeCode.checked = options.includeCode;
  els.includeUser.checked = options.includeUser;
  els.lastEnabled.checked = options.lastMessages > 0;
  els.lastCount.value = String(options.lastMessages > 0 ? options.lastMessages : DEFAULT_LAST);
  els.lastCount.disabled = options.lastMessages === 0;
  els.template.value = options.filenameTemplate;
  els.tags.value = options.tags.join(', ');
  els.callouts.checked = options.callouts;
  updatePreview();
}

function readForm(): ExportOptions {
  const count = Math.min(MAX_LAST_MESSAGES, Math.max(1, Math.floor(Number(els.lastCount.value) || DEFAULT_LAST)));
  return sanitizeExportOptions({
    includeCode: els.includeCode.checked,
    includeUser: els.includeUser.checked,
    lastMessages: els.lastEnabled.checked ? count : 0,
    filenameTemplate: els.template.value,
    tags: parseTags(els.tags.value),
    callouts: els.callouts.checked,
  });
}

function updatePreview(): void {
  els.preview.textContent = exportFilename('Sorting in Python', new Date(), 'md', { template: els.template.value, site: 'chatgpt' });
}

let saveTimer: number | undefined;
function scheduleSave(delay = 0): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), delay);
}

async function save(): Promise<void> {
  try {
    settings = await saveSettings({ exportOptions: readForm() });
    els.saveStatus.className = 'small mt-3 mb-0 status-line text-success-emphasis';
    els.saveStatus.replaceChildren(icon(ICONS.check2), ' Saved');
  } catch {
    els.saveStatus.className = 'small mt-3 mb-0 status-line text-danger';
    els.saveStatus.textContent = "Couldn't save. Please try again.";
  }
}

function renderPlan(plan: PlanState): void {
  const unlocked = plan.has('export-options');
  els.locked.hidden = unlocked;
  els.form.disabled = !unlocked;
  els.planBadge.textContent = plan.plan === 'pro' ? 'Pro' : plan.earlyAccess ? 'Early access: Pro unlocked' : 'Free plan';
  els.planBadge.className = `badge ms-auto ${plan.plan === 'pro' || plan.earlyAccess ? 'pro-badge' : 'text-bg-secondary'}`;
  // No payments adapter yet (src/payments/): the button stays disabled until there is one.
  els.getPro.disabled = true;
  els.getPro.textContent = plan.plan === 'pro' ? 'You have Pro' : 'Get Pro';
  els.proNote.textContent = plan.plan === 'pro' ? 'Thank you!' : plan.earlyAccess ? 'Free during early access' : 'Payments are coming soon.';
}

function renderAboutPro(): void {
  els.price.textContent = PRO_PRICE;
  els.features.replaceChildren(
    ...PRO_FEATURES.map((feature) =>
      h(
        'li',
        { attrs: { 'data-feature': feature.feature } },
        icon(ICONS.check2, { class: 'feature-check' }),
        h('div', {}, h('div', { class: 'fw-semibold', text: feature.title }), h('div', { class: 'small text-body-secondary', text: feature.description })),
      ),
    ),
  );
}

async function init(): Promise<void> {
  for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[data-icon]'))) {
    const name = slot.dataset.icon as keyof typeof ICONS;
    if (ICONS[name]) slot.replaceWith(icon(ICONS[name]));
  }
  renderAboutPro();

  try {
    settings = await loadSettings();
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  els.showButton.checked = settings.showButton;
  fillForm(settings.exportOptions);
  renderPlan(await loadPlan());
  onPlanChanged(renderPlan);
  onSettingsChanged((next) => {
    settings = next;
    els.showButton.checked = next.showButton;
  });

  els.showButton.addEventListener('change', () => {
    saveSettings({ showButton: els.showButton.checked }).catch(() => {
      els.showButton.checked = !els.showButton.checked;
    });
  });
  for (const input of [els.includeCode, els.includeUser, els.callouts]) input.addEventListener('change', () => scheduleSave());
  els.lastEnabled.addEventListener('change', () => {
    els.lastCount.disabled = !els.lastEnabled.checked;
    if (els.lastEnabled.checked) els.lastCount.focus();
    scheduleSave();
  });
  els.lastCount.addEventListener('input', () => scheduleSave(400));
  els.lastCount.addEventListener('change', () => {
    els.lastCount.value = String(readForm().lastMessages || DEFAULT_LAST);
    scheduleSave();
  });
  els.template.addEventListener('input', () => {
    updatePreview();
    scheduleSave(400);
  });
  els.tags.addEventListener('input', () => scheduleSave(400));
  els.tags.addEventListener('change', () => {
    els.tags.value = parseTags(els.tags.value).join(', ');
    scheduleSave();
  });
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-token]'))) {
    button.addEventListener('click', () => {
      const token = button.dataset.token ?? '';
      const { selectionStart, selectionEnd, value } = els.template;
      const start = selectionStart ?? value.length;
      const end = selectionEnd ?? value.length;
      els.template.value = `${value.slice(0, start)}${token}${value.slice(end)}`;
      els.template.focus();
      els.template.setSelectionRange(start + token.length, start + token.length);
      updatePreview();
      scheduleSave();
    });
  }
  // Land on the section the link pointed at (the card is below the fold on small windows).
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' });
}

init().catch((error: unknown) => {
  els.saveStatus.className = 'small mt-3 mb-0 status-line text-danger';
  els.saveStatus.textContent = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
});
