import type { Settings } from '../core/settings';
import { accentById, resolveScheme, themeById, themeVariables, type ColorScheme } from '../core/themes';

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let appliedVariables: string[] = [];

/**
 * Applies a theme and accent to <html>. 'auto' leaves data-bs-theme unset so CSS follows the OS
 * by itself; the accent variables are written for the scheme currently in effect. Uses the CSSOM
 * (style.setProperty), which the page's strict CSP allows, not style attributes.
 */
export function applyTheme(settings: Pick<Settings, 'theme' | 'accent'>): ColorScheme {
  const theme = themeById(settings.theme);
  const accent = accentById(settings.accent);
  const scheme = resolveScheme(theme, darkQuery?.matches ?? false);
  const root = document.documentElement;

  if (theme.scheme === 'auto') root.removeAttribute('data-bs-theme');
  else root.setAttribute('data-bs-theme', theme.scheme);

  const variables = themeVariables(theme, accent, scheme);
  for (const name of appliedVariables) if (!(name in variables)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  appliedVariables = Object.keys(variables);
  root.dataset.accent = accent.id;
  root.dataset.scheme = scheme;
  return scheme;
}

/** For 'auto': the OS switched between light and dark while the page is open. */
export function onSystemSchemeChange(listener: () => void): void {
  darkQuery?.addEventListener('change', listener);
}

export function localeUses12h(): boolean {
  try {
    const options = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
    if (options.hourCycle) return options.hourCycle === 'h11' || options.hourCycle === 'h12';
    return options.hour12 === true;
  } catch {
    return false;
  }
}
