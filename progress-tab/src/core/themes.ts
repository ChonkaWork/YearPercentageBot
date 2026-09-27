/**
 * Look registry. The settings panel offers exactly what is listed here, and the page turns the
 * chosen entries into CSS custom properties, so a new theme or accent is one entry in a list.
 *
 * `tier` marks what everyone gets. A paid tier later would add entries with another tier and
 * filter them by entitlement; there is deliberately no payment code in the MVP.
 */

export type Tier = 'free';
export type ColorScheme = 'light' | 'dark';

export interface ThemeDefinition {
  id: string;
  label: string;
  tier: Tier;
  /** 'auto' follows the operating system. */
  scheme: ColorScheme | 'auto';
  /** Optional CSS custom property overrides per scheme, e.g. { '--pt-page-bg': '#f5efe6' }. */
  tokens?: Partial<Record<ColorScheme, Readonly<Record<string, string>>>>;
}

export const THEMES = [
  { id: 'auto', label: 'Auto', tier: 'free', scheme: 'auto' },
  { id: 'light', label: 'Light', tier: 'free', scheme: 'light' },
  { id: 'dark', label: 'Dark', tier: 'free', scheme: 'dark' },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]['id'];

export interface AccentPalette {
  /** Progress bars, checked controls, focus rings. Only used on cards: at least 3:1 against the surface. */
  fill: string;
  /** Button background; at least 4.5:1 against `onSolid`, also on hover. */
  solid: string;
  solidHover: string;
  onSolid: string;
  /** Accent-colored text and links. At least 4.5:1 against page and surface. */
  text: string;
  /** Tinted background for selected and hovered states. */
  subtle: string;
}

export interface AccentDefinition {
  id: string;
  label: string;
  tier: Tier;
  light: AccentPalette;
  dark: AccentPalette;
}

/** Mint is the Progress Tab brand color (#0ca678); the rest are user choices. */
export const ACCENTS = [
  {
    id: 'mint',
    label: 'Mint',
    tier: 'free',
    light: { fill: '#0ca678', solid: '#087f5b', solidHover: '#066649', onSolid: '#ffffff', text: '#087f5b', subtle: '#e3f8ef' },
    dark: { fill: '#20c997', solid: '#20c997', solidHover: '#38d9a9', onSolid: '#04221a', text: '#38d9a9', subtle: '#12302a' },
  },
  {
    id: 'blue',
    label: 'Blue',
    tier: 'free',
    light: { fill: '#1c7ed6', solid: '#1971c2', solidHover: '#1864ab', onSolid: '#ffffff', text: '#1971c2', subtle: '#eef5fd' },
    dark: { fill: '#4dabf7', solid: '#4dabf7', solidHover: '#74c0fc', onSolid: '#04192b', text: '#74c0fc', subtle: '#132b40' },
  },
  {
    id: 'orange',
    label: 'Orange',
    tier: 'free',
    light: { fill: '#f76707', solid: '#c2410c', solidHover: '#a4370a', onSolid: '#ffffff', text: '#c2410c', subtle: '#fdf0e6' },
    dark: { fill: '#ff922b', solid: '#ff922b', solidHover: '#ffa94d', onSolid: '#2b1400', text: '#ffa94d', subtle: '#3a2512' },
  },
  {
    id: 'pink',
    label: 'Pink',
    tier: 'free',
    light: { fill: '#e64980', solid: '#c2255c', solidHover: '#a61e4d', onSolid: '#ffffff', text: '#c2255c', subtle: '#fcebf2' },
    dark: { fill: '#f06595', solid: '#f783ac', solidHover: '#faa2c1', onSolid: '#2b0a17', text: '#faa2c1', subtle: '#3b1826' },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    tier: 'free',
    light: { fill: '#495057', solid: '#343a40', solidHover: '#212529', onSolid: '#ffffff', text: '#343a40', subtle: '#eceff1' },
    dark: { fill: '#ced4da', solid: '#dee2e6', solidHover: '#f1f3f5', onSolid: '#16191c', text: '#dee2e6', subtle: '#2c3236' },
  },
] as const satisfies readonly AccentDefinition[];

export type AccentId = (typeof ACCENTS)[number]['id'];

/**
 * Page and card backgrounds of the built-in schemes. Mirrors src/styles/_theme.scss (a unit test
 * keeps them in sync); used to check accent contrast.
 */
export const SCHEME_BACKGROUNDS: Readonly<Record<ColorScheme, { page: string; surface: string }>> = {
  light: { page: '#f4f7f6', surface: '#ffffff' },
  dark: { page: '#101413', surface: '#171c1a' },
};

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

export function themeById(id: ThemeId): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function accentById(id: AccentId): AccentDefinition {
  return ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0];
}

export function resolveScheme(theme: ThemeDefinition, prefersDark: boolean): ColorScheme {
  if (theme.scheme === 'auto') return prefersDark ? 'dark' : 'light';
  return theme.scheme;
}

/** CSS custom properties for a theme + accent in the given scheme. Set on :root by the page. */
export function themeVariables(theme: ThemeDefinition, accent: AccentDefinition, scheme: ColorScheme): Record<string, string> {
  const palette = accent[scheme];
  return {
    ...theme.tokens?.[scheme],
    '--pt-accent': palette.fill,
    '--pt-accent-rgb': hexToRgb(palette.fill).join(', '),
    '--pt-accent-solid': palette.solid,
    '--pt-accent-solid-hover': palette.solidHover,
    '--pt-accent-on-solid': palette.onSolid,
    '--pt-accent-text': palette.text,
    '--pt-accent-subtle': palette.subtle,
  };
}

// --- Color math (for contrast checks and rgb() triplets) --------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Expected #rrggbb, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
