import checkIcon from 'bootstrap-icons/icons/check2.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import checkCircleIcon from 'bootstrap-icons/icons/check-circle.svg';
import lockIcon from 'bootstrap-icons/icons/lock.svg';
import {
  checkTemplate,
  DEFAULT_FRONT_MATTER_TEMPLATE,
  FRONT_MATTER_VARIABLES,
  renderFrontMatter,
  SAMPLE_VALUES,
  parseTags,
} from '../core/frontMatter';
import { toMarkdown } from '../core/markdown';
import { EARLY_ACCESS, PRO_FEATURES, PRO_PRICE, proMessage } from '../core/plan';
import { buildQuote, QUOTE_STYLES } from '../core/quote';
import {
  BULLET_MARKERS,
  CSV_DELIMITERS,
  EMPHASIS_MARKERS,
  MARKDOWN_PRESETS,
  matchingPreset,
  SHORTCUT_FORMATS,
  type Settings,
} from '../core/settings';
import { el } from '../core/snapshot';
import { canUse, loadEntitlements, loadSettings, saveSettings, type Entitlements } from '../storage/store';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';
import { proBadge } from '../ui/pro';

const COMMAND = 'copy-selection';
const QUOTE_COMMAND = 'copy-quote';

const els = {
  shortcut: byId<HTMLElement>('shortcut'),
  quoteShortcut: byId<HTMLElement>('quote-shortcut'),
  quoteSample: byId<HTMLDivElement>('quote-sample'),
  fmBadge: byId<HTMLSpanElement>('fm-badge'),
  fmOn: byId<HTMLInputElement>('fm-on'),
  fmTags: byId<HTMLInputElement>('fm-tags'),
  fmTemplate: byId<HTMLTextAreaElement>('fm-template'),
  fmVariables: byId<HTMLDivElement>('fm-variables'),
  fmReset: byId<HTMLButtonElement>('fm-reset'),
  fmIssues: byId<HTMLDivElement>('fm-issues'),
  fmPreview: byId<HTMLPreElement>('fm-preview'),
  fmNote: byId<HTMLDivElement>('fm-note'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  includeLinkUrls: byId<HTMLInputElement>('include-link-urls'),
  markdownSample: byId<HTMLDivElement>('markdown-sample'),
  presets: byId<HTMLDivElement>('presets'),
  presetBadge: byId<HTMLSpanElement>('preset-badge'),
  presetNote: byId<HTMLDivElement>('preset-note'),
  proTitleBadge: byId<HTMLSpanElement>('pro-title-badge'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proStatus: byId<HTMLSpanElement>('pro-status'),
  status: byId<HTMLSpanElement>('save-status'),
};

const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)];
const groups = {
  shortcutFormat: radios('shortcut-format'),
  bulletMarker: radios('bullet'),
  emphasisMarker: radios('emphasis'),
  csvDelimiter: radios('csv-delimiter'),
  quoteStyle: radios('quote-style'),
};

let statusTimer: number | undefined;
let entitlements: Entitlements = { plan: 'free', earlyAccess: EARLY_ACCESS };

const SAMPLE = [
  el('ul', null, el('li', null, 'A list with ', el('em', null, 'italic'), ' text'), el('li', null, el('strong', null, 'Bold'), ' and ', el('code', null, 'code'))),
];

function render(settings: Settings): void {
  for (const input of groups.shortcutFormat) input.checked = input.value === settings.shortcutFormat;
  for (const input of groups.bulletMarker) input.checked = input.value === settings.bulletMarker;
  for (const input of groups.emphasisMarker) input.checked = input.value === settings.emphasisMarker;
  for (const input of groups.csvDelimiter) input.checked = input.value === settings.csvDelimiter;
  for (const input of groups.quoteStyle) input.checked = input.value === settings.quoteStyle;
  els.includeLinkUrls.checked = settings.includeLinkUrls;
  els.quoteSample.textContent = buildQuote(QUOTE_SAMPLE, QUOTE_SOURCE, settings.quoteStyle).payload.text;
  els.fmOn.checked = settings.frontMatter;
  // Don't fight the user's cursor: only fill the fields that aren't being edited.
  if (document.activeElement !== els.fmTags) els.fmTags.value = settings.defaultTags;
  if (document.activeElement !== els.fmTemplate) els.fmTemplate.value = settings.frontMatterTemplate;
  renderTemplateState();
  els.markdownSample.textContent = toMarkdown(SAMPLE, { bullet: settings.bulletMarker, emphasis: settings.emphasisMarker });
  const current = matchingPreset(settings);
  for (const input of els.presets.querySelectorAll<HTMLInputElement>('input[name="preset"]')) input.checked = input.value === current;
}

const QUOTE_SAMPLE = {
  markdown: 'Sleepers leave Vienna at 19:40 and reach Rome at 09:55.',
  text: 'Sleepers leave Vienna at 19:40 and reach Rome at 09:55.',
};
const QUOTE_SOURCE = {
  title: 'Night trains return to Central Europe',
  url: 'https://news.example.com/travel/night-trains-return',
  fragment: 'text=Sleepers%20leave%20Vienna',
};

// --- Front matter (Pro) --------------------------------------------------------------------

let templateTimer: number | undefined;

function renderVariables(): void {
  els.fmVariables.replaceChildren(
    ...FRONT_MATTER_VARIABLES.map((variable) =>
      h('button', {
        class: 'btn btn-sm variable-chip mono',
        text: `{{${variable.name}}}`,
        attrs: { type: 'button', title: `Insert {{${variable.name}}}: ${variable.description}` },
        on: { click: () => insertVariable(variable.name) },
      }),
    ),
  );
}

/** Puts `{{name}}` at the cursor (or on a new `name: {{name}}` line when the cursor is on an empty line). */
function insertVariable(name: string): void {
  const area = els.fmTemplate;
  if (area.disabled) return;
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  const lineStart = area.value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = area.value.indexOf('\n', end);
  const line = area.value.slice(lineStart, lineEnd === -1 ? area.value.length : lineEnd);
  const insert = line.trim() === '' ? `${name}: {{${name}}}` : `{{${name}}}`;
  area.focus();
  area.setRangeText(insert, start, end, 'end');
  onTemplateInput();
}

function renderTemplateState(): void {
  const allowed = canUse(entitlements, 'front-matter');
  const template = els.fmTemplate.value;
  const issues = checkTemplate(template);
  els.fmIssues.replaceChildren(
    ...issues.slice(0, 5).map((issue) =>
      h('div', { class: 'fm-issue' }, svgIcon(errorIcon, 14), h('span', { text: issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message })),
    ),
  );
  els.fmTemplate.classList.toggle('is-invalid', issues.length > 0);
  const values = { ...SAMPLE_VALUES, tags: parseTags(els.fmTags.value) };
  const preview = renderFrontMatter(template, values);
  els.fmPreview.textContent = preview ? preview.trimEnd() : 'No front matter: the template is empty.';
  els.fmPreview.classList.toggle('is-empty', !preview);
  for (const control of [els.fmOn, els.fmTags, els.fmTemplate, els.fmReset]) control.disabled = !allowed;
  for (const chip of els.fmVariables.querySelectorAll('button')) chip.disabled = !allowed || !els.fmOn.checked;
  els.fmTemplate.disabled = !allowed || !els.fmOn.checked;
  els.fmTags.disabled = !allowed || !els.fmOn.checked;
  if (!allowed) {
    els.fmNote.replaceChildren(`${proMessage('front-matter')} `, h('a', { text: 'About Pro', attrs: { href: '#pro' } }));
  } else {
    els.fmNote.textContent = '';
  }
}

function onTemplateInput(): void {
  renderTemplateState();
  window.clearTimeout(templateTimer);
  templateTimer = window.setTimeout(() => void save({ frontMatterTemplate: els.fmTemplate.value, defaultTags: els.fmTags.value }), 400);
}

// --- Markdown presets (Pro) ----------------------------------------------------------------

function renderPresets(): void {
  const allowed = canUse(entitlements, 'markdown-presets');
  els.presetBadge.replaceChildren(proBadge());
  els.presets.replaceChildren(
    ...MARKDOWN_PRESETS.map((preset) => {
      const id = `preset-${preset.id}`;
      const input = h('input', {
        class: 'btn-check',
        attrs: { type: 'radio', name: 'preset', id, value: preset.id, autocomplete: 'off' },
        on: {
          change: () => {
            if (input.checked && canUse(entitlements, 'markdown-presets')) void save(preset.values);
          },
        },
      });
      input.disabled = !allowed;
      const label = h(
        'label',
        { class: 'btn btn-outline-primary preset-option', attrs: { for: id } },
        h('span', { class: 'preset-name', text: preset.label }),
        h('span', { class: 'preset-description mono', text: preset.description }),
      );
      return h('span', { class: 'preset-item' }, input, label);
    }),
  );
  if (allowed) {
    els.presetNote.textContent = 'A preset sets the list bullet and italic marker below. Changing them by hand still works.';
  } else {
    els.presetNote.replaceChildren(`${proMessage('markdown-presets')} `, h('a', { text: 'About Pro', attrs: { href: '#pro' } }));
  }
}

// --- About Pro -----------------------------------------------------------------------------

function renderPro(): void {
  els.proTitleBadge.replaceChildren(proBadge());
  els.proPrice.textContent = `${PRO_PRICE} once`;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map(({ title, description }) =>
      h(
        'li',
        { class: 'd-flex gap-2 mb-2' },
        svgIcon(checkCircleIcon, 16),
        h('div', {}, h('div', { class: 'fw-semibold', text: title }), h('div', { class: 'small text-body-secondary', text: description })),
      ),
    ),
  );
  // No payments yet: the button stays disabled until a payments adapter exists.
  els.getPro.disabled = true;
  els.getPro.replaceChildren(svgIcon(lockIcon, 14), 'Get Pro');
  els.getPro.title = 'Buying Pro isn’t available yet';
  if (entitlements.earlyAccess) {
    els.proStatus.className = 'small fw-semibold text-success-emphasis';
    els.proStatus.textContent = 'Free during early access: every Pro feature is on.';
  } else if (entitlements.plan === 'pro') {
    els.proStatus.className = 'small fw-semibold text-success-emphasis';
    els.proStatus.textContent = 'Pro is active in this browser. Thank you!';
    els.getPro.hidden = true;
  } else {
    els.proStatus.className = 'small text-body-secondary';
    els.proStatus.textContent = 'You are on Free. Buying Pro will be available here soon.';
  }
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
  els.status.className = `save-status ms-auto small fw-semibold d-inline-flex align-items-center gap-1 ${isError ? 'text-danger' : 'text-success'}`;
  els.status.replaceChildren(svgIcon(isError ? errorIcon : checkIcon, 16), text);
  if (!isError) statusTimer = window.setTimeout(() => els.status.replaceChildren(), 1800);
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    els.shortcut.textContent = commands.find((command) => command.name === COMMAND)?.shortcut || 'Not set';
    els.quoteShortcut.textContent = commands.find((command) => command.name === QUOTE_COMMAND)?.shortcut || 'Not set';
  } catch {
    els.shortcut.textContent = 'Unavailable';
    els.quoteShortcut.textContent = 'Unavailable';
  }
}

function onRadio<K extends keyof typeof groups>(key: K, allowed: readonly string[]): void {
  for (const input of groups[key]) {
    input.addEventListener('change', () => {
      if (input.checked && allowed.includes(input.value)) void save({ [key]: input.value } as Partial<Settings>);
    });
  }
}

async function init(): Promise<void> {
  entitlements = await loadEntitlements();
  els.fmBadge.replaceChildren(proBadge());
  renderVariables();
  renderPresets();
  renderPro();
  render(await loadSettings());
  await renderShortcut();
  onRadio('shortcutFormat', SHORTCUT_FORMATS);
  onRadio('bulletMarker', BULLET_MARKERS);
  onRadio('emphasisMarker', EMPHASIS_MARKERS);
  onRadio('csvDelimiter', CSV_DELIMITERS);
  onRadio('quoteStyle', QUOTE_STYLES);
  els.fmOn.addEventListener('change', () => {
    renderTemplateState();
    void save({ frontMatter: els.fmOn.checked });
  });
  els.fmTemplate.addEventListener('input', onTemplateInput);
  els.fmTags.addEventListener('input', onTemplateInput);
  els.fmReset.addEventListener('click', () => {
    els.fmTemplate.value = DEFAULT_FRONT_MATTER_TEMPLATE;
    onTemplateInput();
  });
  els.includeLinkUrls.addEventListener('change', () => void save({ includeLinkUrls: els.includeLinkUrls.checked }));
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());
}

init().catch(() => showStatus("Couldn't load settings.", true));
