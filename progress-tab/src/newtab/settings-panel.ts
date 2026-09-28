import { PRO_FEATURES, PRO_PRICE, isEntitled, type Plan } from '../core/plan';
import { CLOCK_FORMATS, DECIMAL_OPTIONS, sanitizeSettings, type ClockFormat, type Decimals, type Settings } from '../core/settings';
import { ACCENTS, THEMES, themePreview, type ThemeDefinition } from '../core/themes';
import { WEEK_STARTS } from '../core/time';
import { WIDGETS } from '../core/widgets';
import { byId, h, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';

export interface Entitlement {
  plan: Plan;
  earlyAccess: boolean;
}

/** The small PRO label next to Pro features. */
export function proBadge(): HTMLSpanElement {
  return h('span', { class: 'badge-pro', attrs: { title: 'Part of Pro' }, text: 'Pro' });
}

export type SettingsPatch = Partial<Omit<Settings, 'widgets'>> & { widgets?: Partial<Settings['widgets']> };

/** A theme tile: a tiny page with a card and a bar, in the theme's colors for both schemes. */
function themeTile(theme: ThemeDefinition, onChange: () => void): { input: HTMLInputElement; label: HTMLLabelElement } {
  const id = `theme-${theme.id}`;
  const input = h('input', {
    class: 'btn-check',
    attrs: { type: 'radio', name: 'theme', id, value: theme.id, autocomplete: 'off', 'data-tier': theme.tier },
    on: { change: () => input.checked && onChange() },
  });
  const preview = h('span', { class: 'theme-preview', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'theme-preview-card' }, h('span', { class: 'theme-preview-text' }), h('span', { class: 'theme-preview-bar' })));
  for (const scheme of ['light', 'dark'] as const) {
    const colors = themePreview(theme, scheme);
    // CSSOM, not a style attribute: the page CSP forbids inline styles in markup.
    preview.style.setProperty(`--tp-page-${scheme}`, colors.page);
    preview.style.setProperty(`--tp-surface-${scheme}`, colors.surface);
    preview.style.setProperty(`--tp-track-${scheme}`, colors.track);
    preview.style.setProperty(`--tp-text-${scheme}`, colors.text);
  }
  const label = h('label', { class: 'theme-tile', attrs: { for: id } }, preview, h('span', { class: 'theme-name', text: theme.label }), theme.tier === 'pro' ? proBadge() : null);
  return { input, label };
}

const WEEK_START_LABELS: Record<(typeof WEEK_STARTS)[number], string> = { monday: 'Monday', sunday: 'Sunday' };
const CLOCK_LABELS: Record<ClockFormat, string> = { auto: 'Auto', '12h': '12-hour', '24h': '24-hour' };

function decimalsLabel(value: Decimals): string {
  if (value === 'auto') return 'Auto: 2 for the year, 1 for the rest';
  const sample = (74.1234).toFixed(value);
  return `${value} (${sample}%)`;
}

/** A segmented control: radio inputs styled as a Bootstrap button group. */
function segmented<T extends string>(name: string, options: readonly { value: T; label: string }[], onChange: (value: T) => void): HTMLDivElement {
  const group = h('div', { class: 'btn-group btn-group-sm' });
  for (const option of options) {
    const id = `${name}-${option.value}`;
    const input = h('input', {
      class: 'btn-check',
      attrs: { type: 'radio', name, id, value: option.value, autocomplete: 'off' },
      on: { change: () => input.checked && onChange(option.value) },
    });
    group.append(input, h('label', { class: 'btn btn-segment', attrs: { for: id }, text: option.label }));
  }
  return group;
}

/**
 * The settings drawer. Changes apply immediately (the page behind stays visible, so the effect
 * shows right away) and are saved in the background.
 */
export class SettingsPanel {
  private readonly panel = byId<HTMLElement>('settings');
  private readonly toggle = byId<HTMLButtonElement>('open-settings');
  private readonly status = byId<HTMLSpanElement>('save-status');
  private readonly error = byId<HTMLDivElement>('settings-error');
  private readonly decimals = byId<HTMLSelectElement>('decimals');
  private readonly aboutPro = byId<HTMLElement>('about-pro');
  private readonly proStatus = h('p', { class: 'pro-status' });
  private readonly getPro = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button', disabled: '' }, text: 'Get Pro' });
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (patch: SettingsPatch) => void) {
    const switches = byId<HTMLDivElement>('widget-switches');
    for (const widget of WIDGETS) {
      const id = `show-${widget.id}`;
      const input = h('input', {
        class: 'form-check-input',
        attrs: { type: 'checkbox', role: 'switch', id, 'data-widget': widget.id },
        on: { change: () => this.onChange({ widgets: { [widget.id]: input.checked } }) },
      });
      const label = h('label', { class: 'form-check-label', attrs: { for: id } }, widget.label, widget.tier === 'pro' ? proBadge() : null);
      switches.append(h('div', { class: 'form-check form-switch', attrs: { 'data-tier': widget.tier } }, input, label));
    }
    switches.after(this.lockedHint('widgets-locked', 'Life in weeks is part of Pro.'));

    byId('week-start').append(
      segmented('week-start', WEEK_STARTS.map((value) => ({ value, label: WEEK_START_LABELS[value] })), (weekStart) => this.onChange({ weekStart })),
    );
    byId('clock-format').append(
      segmented('clock-format', CLOCK_FORMATS.map((value) => ({ value, label: CLOCK_LABELS[value] })), (clock) => this.onChange({ clock })),
    );
    const themes = byId<HTMLDivElement>('theme');
    for (const theme of THEMES) {
      const tile = themeTile(theme, () => this.onChange({ theme: theme.id }));
      themes.append(tile.input, tile.label);
    }
    themes.after(this.lockedHint('themes-locked', 'The theme pack is part of Pro.'));

    this.buildAboutPro();

    const swatches = byId<HTMLDivElement>('accent');
    for (const accent of ACCENTS) {
      const id = `accent-${accent.id}`;
      const input = h('input', {
        class: 'btn-check',
        attrs: { type: 'radio', name: 'accent', id, value: accent.id, autocomplete: 'off' },
        on: { change: () => input.checked && this.onChange({ accent: accent.id }) },
      });
      const label = h('label', { class: 'swatch', attrs: { for: id, title: accent.label } }, icon('checkLg'), h('span', { class: 'visually-hidden', text: accent.label }));
      // CSSOM, not a style attribute: the page CSP forbids inline styles in markup.
      label.style.setProperty('--swatch-light', accent.light.solid);
      label.style.setProperty('--swatch-light-on', accent.light.onSolid);
      label.style.setProperty('--swatch-dark', accent.dark.solid);
      label.style.setProperty('--swatch-dark-on', accent.dark.onSolid);
      swatches.append(input, label);
    }

    for (const value of DECIMAL_OPTIONS) this.decimals.append(h('option', { attrs: { value: String(value) }, text: decimalsLabel(value) }));
    this.decimals.addEventListener('change', () => this.onChange({ decimals: sanitizeSettings({ decimals: this.decimals.value }).decimals }));

    this.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    byId('close-settings').addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen && !event.defaultPrevented) {
        event.preventDefault();
        this.close();
      }
    });
  }

  private lockedHint(id: string, text: string): HTMLParagraphElement {
    return h(
      'p',
      { class: 'pro-hint', attrs: { id, hidden: '' } },
      icon('lock'),
      h('span', { text: `${text} ` }),
      h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'About Pro', on: { click: () => this.showAboutPro() } }),
    );
  }

  private buildAboutPro(): void {
    const features = h('ul', { class: 'pro-features' });
    for (const feature of PRO_FEATURES) {
      features.append(h('li', {}, icon('check2'), h('span', {}, h('strong', { text: feature.title }), ` ${feature.description}`)));
    }
    this.aboutPro.append(
      h(
        'div',
        { class: 'pro-head' },
        h('h3', { attrs: { id: 'about-pro-title' }, text: 'About Pro' }),
        proBadge(),
        h('span', { class: 'pro-price', text: `${PRO_PRICE} once` }),
      ),
      h('p', { class: 'pro-intro', text: 'The basics stay free. Pro adds:' }),
      features,
      h('div', { class: 'pro-actions' }, this.getPro, this.proStatus),
    );
  }

  /** Opens the drawer on the About Pro card (from a limit message or a locked feature). */
  showAboutPro(): void {
    if (!this.isOpen) this.open();
    this.aboutPro.scrollIntoView({ block: 'nearest' });
    this.aboutPro.focus({ preventScroll: true });
  }

  /** Enables what the plan includes; shows PRO hints and the About Pro status. */
  renderPlan(entitlement: Entitlement): void {
    const { plan, earlyAccess } = entitlement;
    let themesLocked = false;
    for (const theme of THEMES) {
      const locked = !isEntitled(theme, plan, earlyAccess);
      themesLocked ||= locked;
      const input = byId<HTMLInputElement>(`theme-${theme.id}`);
      if (input.disabled !== locked) input.disabled = locked;
    }
    let widgetsLocked = false;
    for (const widget of WIDGETS) {
      const locked = !isEntitled(widget, plan, earlyAccess);
      widgetsLocked ||= locked;
      const input = byId<HTMLInputElement>(`show-${widget.id}`);
      if (input.disabled !== locked) input.disabled = locked;
    }
    setHidden(byId('themes-locked'), !themesLocked);
    setHidden(byId('widgets-locked'), !widgetsLocked);

    const hasPro = plan === 'pro';
    this.aboutPro.dataset.plan = earlyAccess ? 'early-access' : plan;
    setHidden(this.getPro, hasPro && !earlyAccess);
    setText(
      this.proStatus,
      earlyAccess ? 'Free during early access' : hasPro ? 'You have Pro. Thank you!' : 'Payments aren’t available yet.',
    );
  }

  get isOpen(): boolean {
    return this.panel.classList.contains('show');
  }

  open(): void {
    this.panel.classList.add('show');
    document.body.classList.add('settings-open');
    this.toggle.setAttribute('aria-expanded', 'true');
    this.panel.focus();
  }

  close(): void {
    const hadFocus = this.panel.contains(document.activeElement);
    this.panel.classList.remove('show');
    document.body.classList.remove('settings-open');
    this.toggle.setAttribute('aria-expanded', 'false');
    if (hadFocus) this.toggle.focus();
  }

  /** Shows the given settings in the controls. */
  render(settings: Settings): void {
    for (const input of this.panel.querySelectorAll<HTMLInputElement>('input[data-widget]')) {
      input.checked = settings.widgets[input.dataset.widget as keyof Settings['widgets']] ?? true;
    }
    const check = (name: string, value: string) => {
      for (const input of this.panel.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === value;
    };
    check('week-start', settings.weekStart);
    check('clock-format', settings.clock);
    check('theme', settings.theme);
    check('accent', settings.accent);
    this.decimals.value = String(settings.decimals);
  }

  showSaved(): void {
    this.showError(null);
    clearTimeout(this.statusTimer);
    this.status.replaceChildren(icon('check2'), 'Saved');
    this.statusTimer = setTimeout(() => this.status.replaceChildren(), 1600);
  }

  showError(message: string | null): void {
    this.error.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(this.error, !message);
    if (message) {
      clearTimeout(this.statusTimer);
      this.status.replaceChildren();
    }
  }
}
