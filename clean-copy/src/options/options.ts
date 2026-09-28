import arrowDownIcon from 'bootstrap-icons/icons/arrow-down.svg';
import arrowUpIcon from 'bootstrap-icons/icons/arrow-up.svg';
import checkIcon from 'bootstrap-icons/icons/check2.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import globeIcon from 'bootstrap-icons/icons/globe2.svg';
import plusIcon from 'bootstrap-icons/icons/plus-lg.svg';
import trashIcon from 'bootstrap-icons/icons/trash3.svg';
import { cleanCopy } from '../core/cleaner';
import { EARLY_ACCESS, hasFeature, limitsFor, PRO_FEATURES, PRO_PRICE } from '../core/plan';
import { emptyRule, RULE_LIMITS, RULE_PRESETS, ruleFromPreset, validateRule, type Rule } from '../core/rules';
import type { Settings } from '../core/settings';
import { ALL_SITES_PATTERN, parseSiteInput } from '../core/sites';
import { KEYS, loadState, saveAllSites, saveRules, saveSettings, type State } from '../storage/store';
import { byId, h } from '../ui/dom';
import { plural } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { addSite, grantSite, removeSite, requestSync, siteStatuses } from '../ui/sites';

const COMMAND = 'copy-clean';
const COMMAND_CLIPBOARD = 'clean-clipboard';
const CLIPBOARD_PERMISSION: chrome.permissions.Permissions = { permissions: ['clipboardRead'] };

const els = {
  status: byId<HTMLSpanElement>('save-status'),
  keepBullets: byId<HTMLInputElement>('keep-bullets'),
  stripTracking: byId<HTMLInputElement>('strip-tracking'),
  collapseWhitespace: byId<HTMLInputElement>('collapse-whitespace'),
  keepLinkUrls: byId<HTMLInputElement>('keep-link-urls'),
  typography: byId<HTMLInputElement>('typography'),
  dashes: byId<HTMLSelectElement>('dashes'),
  removeMarkdown: byId<HTMLInputElement>('remove-markdown'),
  sampleBefore: byId<HTMLPreElement>('sample-before'),
  sampleAfter: byId<HTMLPreElement>('sample-after'),
  shortcut: byId<HTMLElement>('shortcut'),
  shortcutClipboard: byId<HTMLElement>('shortcut-clipboard'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  clipboardState: byId<HTMLSpanElement>('clipboard-state'),
  clipboardRevoke: byId<HTMLButtonElement>('clipboard-revoke'),
  autoLocked: byId<HTMLDivElement>('auto-locked'),
  autoFieldset: byId<HTMLFieldSetElement>('auto-fieldset'),
  sites: byId<HTMLUListElement>('sites'),
  addSiteForm: byId<HTMLFormElement>('add-site-form'),
  addSite: byId<HTMLInputElement>('add-site'),
  addSiteError: byId<HTMLDivElement>('add-site-error'),
  autoAll: byId<HTMLInputElement>('auto-all'),
  autoAllState: byId<HTMLDivElement>('auto-all-state'),
  autoEditors: byId<HTMLInputElement>('auto-editors'),
  autoToast: byId<HTMLInputElement>('auto-toast'),
  rulesLocked: byId<HTMLDivElement>('rules-locked'),
  rulesFieldset: byId<HTMLFieldSetElement>('rules-fieldset'),
  rules: byId<HTMLOListElement>('rules'),
  addRule: byId<HTMLButtonElement>('add-rule'),
  addPreset: byId<HTMLSelectElement>('add-preset'),
  rulesInput: byId<HTMLTextAreaElement>('rules-input'),
  rulesOutput: byId<HTMLPreElement>('rules-output'),
  rulesSummary: byId<HTMLDivElement>('rules-summary'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proNote: byId<HTMLSpanElement>('pro-note'),
  nav: byId<HTMLElement>('section-nav'),
};
const lineBreakRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="line-breaks"]')];

let state: State;
let statusTimer: number | undefined;
let rulesTimer: number | undefined;

const SAMPLE = [
  'Our   new pricing​ page is live:',
  'https://example.com/pricing?utm_source=newsletter&utm_medium=email&plan=pro',
  '',
  'We rebuilt the editor from',
  'scratch, so long documents',
  'open twice as fast.',
  '',
  '• Faster exports',
  '• Shared work-',
  '  spaces for teams',
].join('\n');

const RULES_SAMPLE = 'Order #1234 shipped.\nRead more at: https://example.com/news/42?fbclid=abc\nCall us: +1 (555) 010-0199';

// --- Status -----------------------------------------------------------------------------

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.className = `save-status ms-auto small fw-semibold d-inline-flex align-items-center gap-1 ${isError ? 'text-danger' : 'text-success'}`;
  els.status.replaceChildren(svgIcon(isError ? errorIcon : checkIcon, 16), text);
  if (!isError) statusTimer = window.setTimeout(() => els.status.replaceChildren(), 1800);
}

// --- Cleanup options --------------------------------------------------------------------

function renderSettings(settings: Settings): void {
  for (const input of lineBreakRadios) input.checked = input.value === settings.lineBreaks;
  els.keepBullets.checked = settings.keepBullets;
  els.stripTracking.checked = settings.stripTracking;
  els.collapseWhitespace.checked = settings.collapseWhitespace;
  els.keepLinkUrls.checked = settings.keepLinkUrls;
  els.typography.checked = settings.typography;
  els.dashes.value = settings.dashes;
  els.dashes.disabled = !settings.typography;
  els.removeMarkdown.checked = settings.removeMarkdown;
  els.autoEditors.checked = settings.autoCleanEditors;
  els.autoToast.checked = settings.autoCleanToast;
  els.sampleBefore.textContent = SAMPLE;
  // The built-in cleanup only: the example shows what the switches above do.
  els.sampleAfter.textContent = cleanCopy({ kind: 'plain', text: SAMPLE }, settings).text;
  renderRulesPreview();
}

async function save(patch: Partial<Settings>): Promise<void> {
  try {
    state.settings = await saveSettings(patch);
    renderSettings(state.settings);
    showStatus('Saved');
  } catch {
    showStatus("Couldn't save. Please try again.", true);
  }
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    els.shortcut.textContent = commands.find((command) => command.name === COMMAND)?.shortcut || 'Not set';
    els.shortcutClipboard.textContent = commands.find((command) => command.name === COMMAND_CLIPBOARD)?.shortcut || 'Not set';
  } catch {
    els.shortcut.textContent = 'Unavailable';
    els.shortcutClipboard.textContent = 'Unavailable';
  }
}

// --- Clipboard access -------------------------------------------------------------------

async function renderClipboardAccess(): Promise<void> {
  const granted = await chrome.permissions.contains(CLIPBOARD_PERMISSION).catch(() => false);
  els.clipboardState.textContent = granted
    ? 'Allowed. Used only when you click Clean clipboard or press its shortcut.'
    : 'Not allowed. Clean clipboard asks the first time you use it.';
  els.clipboardRevoke.hidden = !granted;
}

async function revokeClipboard(): Promise<void> {
  let removed = false;
  try {
    removed = await chrome.permissions.remove(CLIPBOARD_PERMISSION);
  } catch {
    removed = false;
  }
  if (removed) showStatus('Clipboard access removed');
  else showStatus("Couldn't remove it here. Use chrome://extensions → Details.", true);
  await renderClipboardAccess();
}

// --- Pro --------------------------------------------------------------------------------

function renderPro(): void {
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map((feature) => h('li', { class: 'mb-1' }, h('strong', { text: feature.title }), `: ${feature.detail}`)),
  );
  els.getPro.textContent = `Get Pro · ${PRO_PRICE} once`;
  els.getPro.disabled = true;
  els.proNote.textContent = EARLY_ACCESS ? 'Free during early access: every Pro feature is on.' : state.plan === 'pro' ? 'Pro is active. Thank you!' : 'Payments are not available yet.';

  const autoOn = hasFeature(state.plan, 'auto-clean');
  const rulesOn = hasFeature(state.plan, 'custom-rules');
  els.autoFieldset.disabled = !autoOn;
  els.rulesFieldset.disabled = !rulesOn;
  const locked = (element: HTMLElement, on: boolean, text: string) => {
    element.hidden = on;
    element.className = on ? '' : 'alert alert-primary small py-2 mb-3';
    element.textContent = on ? '' : text;
  };
  locked(els.autoLocked, autoOn, 'Auto-clean is a Pro feature. Your sites are kept; they are cleaned again once Pro is active.');
  locked(els.rulesLocked, rulesOn, 'Custom rules are a Pro feature. Your rules are kept; they apply again once Pro is active.');
}

// --- Sites ------------------------------------------------------------------------------

async function renderSites(): Promise<void> {
  const statuses = await siteStatuses(state.sites);
  if (statuses.length === 0) {
    els.sites.replaceChildren(
      h('li', { class: 'list-group-item empty-state' }, svgIcon(globeIcon, 22), h('span', { text: 'No sites yet. Add one below, or use the switch in the toolbar popup while you are on it.' })),
    );
    return;
  }
  els.sites.replaceChildren(
    ...statuses.map(({ host, active }) => {
      const remove = h('button', { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': `Remove ${host}`, title: 'Remove', 'data-action': 'remove' } }, svgIcon(trashIcon, 15));
      remove.addEventListener('click', () => void onRemoveSite(host));
      const badge = active
        ? h('span', { class: 'badge bg-success-subtle text-success-emphasis border border-success-subtle', text: 'Active' })
        : h('button', { class: 'btn btn-outline-warning btn-sm py-0', text: 'Allow access', attrs: { type: 'button', 'data-action': 'grant' }, on: { click: () => void onGrantSite(host) } });
      return h('li', { class: 'list-group-item d-flex align-items-center gap-2 site-item', attrs: { 'data-host': host } }, h('span', { class: 'mono text-break', text: host }), h('span', { class: 'ms-auto' }, badge), remove);
    }),
  );
}

async function onAddSite(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const parsed = parseSiteInput(els.addSite.value);
  if (!parsed.ok) return setSiteError(parsed.message);
  if (state.sites.includes(parsed.host)) return setSiteError(`${parsed.host} is already in the list.`);
  if (state.sites.length >= limitsFor(state.plan).maxSites) return setSiteError('The list is full. Remove a site first.');
  setSiteError('');
  // The permission prompt must come straight from the click: no awaits before it.
  const granted = await addSite(parsed.host, state.sites);
  state = await loadState();
  if (granted) {
    els.addSite.value = '';
    showStatus(`Auto-clean is on for ${parsed.host}`);
  } else {
    setSiteError(`Chrome didn't give Clean Copy access to ${parsed.host}, so it wasn't added.`);
  }
  await renderSites();
}

function setSiteError(message: string): void {
  els.addSiteError.textContent = message;
  els.addSite.classList.toggle('is-invalid', Boolean(message));
}

async function onGrantSite(host: string): Promise<void> {
  const granted = await grantSite(host);
  if (!granted) showStatus(`No access to ${host}`, true);
  await renderSites();
}

// --- All sites ----------------------------------------------------------------------------

async function renderAllSites(): Promise<void> {
  const granted = await chrome.permissions.contains({ origins: [ALL_SITES_PATTERN] }).catch(() => false);
  els.autoAll.checked = state.allSites && granted;
  els.autoAllState.className = 'small mt-1';
  if (state.allSites && granted) {
    els.autoAllState.classList.add('text-primary-emphasis', 'fw-semibold');
    els.autoAllState.textContent = 'On: every copy on every site comes out clean. The list above is kept for when you turn this off.';
  } else if (state.allSites) {
    els.autoAllState.classList.add('text-warning-emphasis');
    els.autoAllState.textContent = "Chrome's access to all sites was removed, so All sites is off. Turn it on again to ask.";
  } else {
    els.autoAllState.textContent = '';
  }
}

async function onAllSites(): Promise<void> {
  if (els.autoAll.checked) {
    // The permission prompt must come straight from the click: no awaits before it.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [ALL_SITES_PATTERN] });
    } catch {
      granted = false;
    }
    if (!granted) {
      els.autoAll.checked = false;
      showStatus("Chrome didn't give access to all sites", true);
      return;
    }
    await saveAllSites(true);
    state.allSites = true;
    await requestSync();
    showStatus('Auto-clean is on for all sites');
  } else {
    await saveAllSites(false);
    state.allSites = false;
    try {
      // Only the all-sites access goes back; access to the sites in the list stays.
      await chrome.permissions.remove({ origins: [ALL_SITES_PATTERN] });
    } catch {
      // Required in the e2e build; nothing else to do.
    }
    await requestSync();
    showStatus('All sites is off');
  }
  await Promise.all([renderSites(), renderAllSites()]);
  if (!state.allSites) {
    const lost = (await siteStatuses(state.sites)).filter((site) => !site.active).length;
    if (lost) {
      els.autoAllState.className = 'small mt-1 text-warning-emphasis';
      els.autoAllState.textContent = `${lost} ${plural(lost, 'site')} in the list ${lost === 1 ? 'needs' : 'need'} access again: use Allow access next to ${lost === 1 ? 'it' : 'them'}.`;
    }
  }
}

async function onRemoveSite(host: string): Promise<void> {
  try {
    state.sites = await removeSite(host, state.sites);
    showStatus(`Removed ${host}`);
  } catch {
    showStatus("Couldn't remove the site. Please try again.", true);
  }
  await renderSites();
}

// --- Rules ------------------------------------------------------------------------------

function renderRules(): void {
  const rules = state.rules;
  if (rules.length === 0) {
    els.rules.replaceChildren(h('li', { class: 'empty-state rule-empty', text: 'No rules yet. Built-in cleanup still runs on every copy.' }));
  } else {
    els.rules.replaceChildren(...rules.map((rule, index) => ruleRow(rule, index, rules.length)));
  }
  els.addRule.replaceChildren(svgIcon(plusIcon, 14), ' Add rule');
  els.addRule.disabled = rules.length >= RULE_LIMITS.maxRules;
  els.addPreset.disabled = els.addRule.disabled;
  renderRulesPreview();
}

function ruleRow(rule: Rule, index: number, total: number): HTMLLIElement {
  const id = rule.id;
  const enabled = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: `${id}-on`, 'aria-label': `Rule ${index + 1} on` } });
  enabled.checked = rule.enabled;
  enabled.addEventListener('change', () => updateRule(id, { enabled: enabled.checked }, true));

  const mode = h(
    'select',
    { class: 'form-select form-select-sm rule-mode', attrs: { 'aria-label': `Rule ${index + 1} match type` } },
    h('option', { text: 'Text', attrs: { value: 'text' } }),
    h('option', { text: 'Regex', attrs: { value: 'regex' } }),
  );
  mode.value = rule.mode;
  mode.addEventListener('change', () => updateRule(id, { mode: mode.value === 'regex' ? 'regex' : 'text' }, true));

  const caseInput = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id: `${id}-case` } });
  caseInput.checked = rule.caseSensitive;
  caseInput.addEventListener('change', () => updateRule(id, { caseSensitive: caseInput.checked }, true));

  const find = h('input', {
    class: 'form-control form-control-sm mono rule-find',
    attrs: { type: 'text', placeholder: 'Find', 'aria-label': `Rule ${index + 1} find`, spellcheck: 'false', maxlength: String(RULE_LIMITS.maxFindLength) },
  });
  find.value = rule.find;
  const replace = h('input', {
    class: 'form-control form-control-sm mono rule-replace',
    attrs: { type: 'text', placeholder: 'Replace with (empty removes)', 'aria-label': `Rule ${index + 1} replace with`, spellcheck: 'false', maxlength: String(RULE_LIMITS.maxReplaceLength) },
  });
  replace.value = rule.replace;
  const error = h('div', { class: 'invalid-feedback d-block rule-error', attrs: { id: `${id}-error`, 'aria-live': 'polite' } });
  find.setAttribute('aria-describedby', error.id);
  find.addEventListener('input', () => updateRule(id, { find: find.value }, false));
  replace.addEventListener('input', () => updateRule(id, { replace: replace.value }, false));

  const button = (icon: string, label: string, action: string, disabled: boolean, handler: () => void) => {
    const element = h('button', { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': `${label} rule ${index + 1}`, title: label, 'data-action': action } }, svgIcon(icon, 15));
    element.disabled = disabled;
    element.addEventListener('click', handler);
    return element;
  };

  const row = h(
    'li',
    { class: 'rule', attrs: { 'data-id': id } },
    h(
      'div',
      { class: 'rule-head' },
      h('span', { class: 'rule-number mono', text: String(index + 1) }),
      h('div', { class: 'form-check form-switch m-0' }, enabled),
      mode,
      h('div', { class: 'form-check m-0 small' }, caseInput, h('label', { class: 'form-check-label', text: 'Match case', attrs: { for: caseInput.id } })),
      h(
        'div',
        { class: 'ms-auto d-flex' },
        button(arrowUpIcon, 'Move up', 'up', index === 0, () => moveRule(id, -1)),
        button(arrowDownIcon, 'Move down', 'down', index === total - 1, () => moveRule(id, 1)),
        button(trashIcon, 'Delete', 'delete', false, () => deleteRule(id)),
      ),
    ),
    h('div', { class: 'rule-fields' }, find, replace),
    error,
  );
  showRuleValidation(row, rule);
  return row;
}

function showRuleValidation(row: HTMLElement, rule: Rule): void {
  const find = row.querySelector<HTMLInputElement>('.rule-find');
  const error = row.querySelector<HTMLDivElement>('.rule-error');
  if (!find || !error) return;
  const validation = rule.find === '' ? null : validateRule(rule);
  const message = validation && !validation.ok ? validation.message : '';
  error.textContent = message;
  find.classList.toggle('is-invalid', Boolean(message));
  row.classList.toggle('is-disabled', !rule.enabled);
}

function updateRule(id: string, patch: Partial<Rule>, immediate: boolean): void {
  state.rules = state.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule));
  const rule = state.rules.find((item) => item.id === id);
  const row = els.rules.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (rule && row) showRuleValidation(row, rule);
  renderRulesPreview();
  scheduleRulesSave(immediate ? 0 : 400);
}

function moveRule(id: string, step: number): void {
  const index = state.rules.findIndex((rule) => rule.id === id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= state.rules.length) return;
  const rules = [...state.rules];
  const [moved] = rules.splice(index, 1);
  if (moved) rules.splice(target, 0, moved);
  state.rules = rules;
  renderRules();
  els.rules.querySelector<HTMLButtonElement>(`[data-id="${id}"] [data-action="${step < 0 ? 'up' : 'down'}"]:not(:disabled)`)?.focus();
  scheduleRulesSave(0);
}

function deleteRule(id: string): void {
  state.rules = state.rules.filter((rule) => rule.id !== id);
  renderRules();
  els.addRule.focus();
  scheduleRulesSave(0);
}

function renderPresets(): void {
  els.addPreset.replaceChildren(
    h('option', { text: 'Add from preset…', attrs: { value: '' } }),
    ...RULE_PRESETS.map((preset) => h('option', { text: preset.label, attrs: { value: preset.id } })),
  );
  els.addPreset.disabled = state.rules.length >= RULE_LIMITS.maxRules;
}

function addPreset(): void {
  const preset = RULE_PRESETS.find((item) => item.id === els.addPreset.value);
  els.addPreset.value = '';
  if (!preset || state.rules.length >= RULE_LIMITS.maxRules) return;
  if (state.rules.some((rule) => rule.mode === preset.rule.mode && rule.find === preset.rule.find)) {
    showStatus('That rule is already in the list', true);
    return;
  }
  state.rules = [...state.rules, ruleFromPreset(preset)];
  renderRules();
  scheduleRulesSave(0);
}

function addRule(): void {
  if (state.rules.length >= RULE_LIMITS.maxRules) return;
  const rule = emptyRule();
  state.rules = [...state.rules, rule];
  renderRules();
  els.rules.querySelector<HTMLInputElement>(`[data-id="${rule.id}"] .rule-find`)?.focus();
  scheduleRulesSave(0);
}

function scheduleRulesSave(delay: number): void {
  window.clearTimeout(rulesTimer);
  rulesTimer = window.setTimeout(() => {
    saveRules(state.rules)
      .then(() => showStatus('Saved'))
      .catch(() => showStatus("Couldn't save the rules. Please try again.", true));
  }, delay);
}

/** Live preview: the sample goes through the built-in cleanup, then the rules, like a real copy. */
function renderRulesPreview(): void {
  const input = els.rulesInput.value;
  const { text, stats } = cleanCopy({ kind: 'plain', text: input }, state.settings, state.rules);
  els.rulesOutput.textContent = text;
  const parts: string[] = [];
  const invalid = state.rules.filter((rule) => rule.find !== '' && !validateRule(rule).ok).length;
  if (state.rules.length === 0) parts.push('Add a rule to see it applied here.');
  else parts.push(`${stats.replacements} ${plural(stats.replacements, 'replacement')} by ${stats.rulesApplied} ${plural(stats.rulesApplied, 'rule')}`);
  if (invalid) parts.push(`${invalid} ${plural(invalid, 'rule')} with an error ${invalid === 1 ? 'is' : 'are'} skipped`);
  if (stats.rulesStopped) parts.push('stopped early: a rule hit the time or size limit');
  els.rulesSummary.textContent = parts.join(' · ');
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  state = await loadState();
  els.rulesInput.value = RULES_SAMPLE;
  renderSettings(state.settings);
  renderPro();
  renderPresets();
  renderRules();
  setUpNav();
  await Promise.all([renderShortcut(), renderSites(), renderAllSites(), renderClipboardAccess()]);

  for (const input of lineBreakRadios) {
    input.addEventListener('change', () => {
      if (input.checked) void save({ lineBreaks: input.value === 'merge' ? 'merge' : 'keep' });
    });
  }
  els.keepBullets.addEventListener('change', () => void save({ keepBullets: els.keepBullets.checked }));
  els.stripTracking.addEventListener('change', () => void save({ stripTracking: els.stripTracking.checked }));
  els.collapseWhitespace.addEventListener('change', () => void save({ collapseWhitespace: els.collapseWhitespace.checked }));
  els.keepLinkUrls.addEventListener('change', () => void save({ keepLinkUrls: els.keepLinkUrls.checked }));
  els.typography.addEventListener('change', () => void save({ typography: els.typography.checked }));
  els.dashes.addEventListener('change', () => void save({ dashes: els.dashes.value === 'keep' ? 'keep' : 'hyphen' }));
  els.removeMarkdown.addEventListener('change', () => void save({ removeMarkdown: els.removeMarkdown.checked }));
  els.autoAll.addEventListener('change', () => void onAllSites());
  els.addPreset.addEventListener('change', addPreset);
  els.clipboardRevoke.addEventListener('click', () => void revokeClipboard());
  els.autoEditors.addEventListener('change', () => void save({ autoCleanEditors: els.autoEditors.checked }));
  els.autoToast.addEventListener('change', () => void save({ autoCleanToast: els.autoToast.checked }));
  els.addSiteForm.addEventListener('submit', (event) => void onAddSite(event));
  els.addSite.addEventListener('input', () => setSiteError(''));
  els.addRule.addEventListener('click', addRule);
  els.rulesInput.addEventListener('input', renderRulesPreview);
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());
  // Sites added or removed from the popup, or permissions changed on chrome://extensions.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(KEYS.sites in changes)) return;
    void loadState().then((next) => {
      state.sites = next.sites;
      return renderSites();
    });
  });
  chrome.permissions.onAdded.addListener(() => void Promise.all([renderSites(), renderAllSites(), renderClipboardAccess()]));
  chrome.permissions.onRemoved.addListener(() => void Promise.all([renderSites(), renderAllSites(), renderClipboardAccess()]));
}

// --- Section nav --------------------------------------------------------------------------

/** Highlights the section being read in the sticky nav. */
function setUpNav(): void {
  const links = [...els.nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const sections = links.map((link) => document.getElementById(link.hash.slice(1))).filter((section): section is HTMLElement => section !== null);
  const visible = new Set<Element>();
  const mark = () => {
    const current = sections.find((section) => visible.has(section)) ?? sections[0];
    for (const link of links) {
      const active = link.hash === `#${current?.id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      mark();
    },
    // A section counts once it reaches the band just under the sticky nav.
    { rootMargin: '-72px 0px -55% 0px' },
  );
  for (const section of sections) observer.observe(section);
  for (const link of links) {
    link.addEventListener('click', () => {
      // The target card gets focus for keyboard and screen reader users.
      const target = document.getElementById(link.hash.slice(1));
      window.setTimeout(() => target?.focus({ preventScroll: true }), 0);
    });
  }
  mark();
}

init().catch(() => showStatus("Couldn't load settings.", true));
