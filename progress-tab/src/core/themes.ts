/**
 * Look registry. The settings panel offers exactly what is listed here, and the page turns the
 * chosen entries into CSS custom properties, so a new theme or accent is one entry in a list.
 *
 * `tier` says who gets an entry: 'free' for everyone, 'pro' (with the Pro feature it belongs to)
 * when the plan includes it (see plan.ts). There is no payment code here.
 */

import type { Tiered } from './plan';

export type { Tier } from './plan';
export type ColorScheme = 'light' | 'dark';

/**
 * The page colors a theme can set. Bootstrap's own variables are included so text, borders and
 * form backgrounds match the theme; anything left out keeps the built-in scheme's value.
 */
export type ThemeTokens = {
  '--pt-page-bg': string;
  '--pt-surface': string;
  '--pt-track': string;
  '--bs-body-color': string;
  '--bs-emphasis-color': string;
  '--bs-secondary-color': string;
  '--bs-border-color': string;
  '--bs-secondary-bg': string;
  '--bs-tertiary-bg': string;
};

export type ThemeDefinition = {
  id: string;
  label: string;
  /** 'auto' follows the operating system. */
  scheme: ColorScheme | 'auto';
  /** Optional CSS custom property overrides per scheme, e.g. { '--pt-page-bg': '#f5efe6' }. */
  tokens?: Partial<Record<ColorScheme, Readonly<Partial<ThemeTokens> & Record<string, string>>>>;
} & Tiered;

function tokens(
  page: string,
  surface: string,
  track: string,
  body: string,
  emphasis: string,
  secondary: string,
  border: string,
  secondaryBg: string,
  tertiaryBg: string,
): ThemeTokens {
  return {
    '--pt-page-bg': page,
    '--pt-surface': surface,
    '--pt-track': track,
    '--bs-body-color': body,
    '--bs-emphasis-color': emphasis,
    '--bs-secondary-color': secondary,
    '--bs-border-color': border,
    '--bs-secondary-bg': secondaryBg,
    '--bs-tertiary-bg': tertiaryBg,
  };
}

/**
 * Light and Dark are free ("Auto" switches between them with the OS). The Pro theme pack follows
 * the OS too and has a light and a dark variant of each; every accent stays readable on both
 * (unit-tested with the same contrast rules as the built-in schemes).
 */
export const THEMES = [
  { id: 'auto', label: 'Auto', tier: 'free', scheme: 'auto' },
  { id: 'light', label: 'Light', tier: 'free', scheme: 'light' },
  { id: 'dark', label: 'Dark', tier: 'free', scheme: 'dark' },
  {
    id: 'paper',
    label: 'Paper',
    tier: 'pro',
    feature: 'theme-pack',
    scheme: 'auto',
    tokens: {
      light: tokens('#f8f4ed', '#ffffff', '#ebe4d7', '#2a241c', '#14100a', '#6a5f50', '#e6ddce', '#efe8dc', '#faf6f0'),
      dark: tokens('#15120e', '#1e1a15', '#342d24', '#ebe3d6', '#ffffff', '#a99e8d', '#362f26', '#2c261f', '#221e18'),
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    tier: 'pro',
    feature: 'theme-pack',
    scheme: 'auto',
    tokens: {
      light: tokens('#f1f4f8', '#ffffff', '#e1e7ee', '#18212c', '#0b1118', '#556274', '#d8e0e9', '#e3e9f0', '#f5f7fa'),
      dark: tokens('#0e131a', '#151c25', '#263142', '#dfe6ef', '#ffffff', '#95a3b5', '#263140', '#222c39', '#19212b'),
    },
  },
  {
    id: 'sage',
    label: 'Sage',
    tier: 'pro',
    feature: 'theme-pack',
    scheme: 'auto',
    tokens: {
      light: tokens('#f1f5ee', '#ffffff', '#dfe7da', '#1b2419', '#0d130c', '#566657', '#d5ded0', '#e3eadf', '#f5f8f3'),
      dark: tokens('#10150f', '#171e16', '#283327', '#e0e8dc', '#ffffff', '#9aaa97', '#283327', '#232c22', '#1b2319'),
    },
  },
  {
    id: 'clay',
    label: 'Clay',
    tier: 'pro',
    feature: 'theme-pack',
    scheme: 'auto',
    tokens: {
      light: tokens('#f8f2ee', '#ffffff', '#eee1da', '#2d211d', '#170f0c', '#735f57', '#eadbd3', '#f0e5df', '#fbf6f3'),
      dark: tokens('#18110f', '#211816', '#3b2c28', '#f0e3de', '#ffffff', '#b39f98', '#3b2d29', '#302420', '#261c19'),
    },
  },
  {
    id: 'contrast',
    label: 'High contrast',
    tier: 'pro',
    feature: 'theme-pack',
    scheme: 'auto',
    tokens: {
      light: tokens('#ffffff', '#ffffff', '#d4d4d4', '#000000', '#000000', '#3d3d3d', '#767676', '#e6e6e6', '#f5f5f5'),
      dark: tokens('#000000', '#0b0b0b', '#3a3a3a', '#ffffff', '#ffffff', '#c8c8c8', '#8a8a8a', '#262626', '#141414'),
    },
  },
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

export type AccentDefinition = {
  id: string;
  label: string;
  light: AccentPalette;
  dark: AccentPalette;
} & Tiered;

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

/** Text and bar-track colors of the built-in schemes (from _theme.scss), for theme previews. */
const SCHEME_INK: Readonly<Record<ColorScheme, { text: string; track: string }>> = {
  light: { text: '#17201d', track: '#e8eeeb' },
  dark: { text: '#e3e9e6', track: '#252d2a' },
};

export interface ThemePreview {
  page: string;
  surface: string;
  track: string;
  text: string;
}

/** Colors for the small preview tile in settings. A fixed-scheme theme looks the same in both. */
export function themePreview(theme: ThemeDefinition, scheme: ColorScheme): ThemePreview {
  const effective = theme.scheme === 'auto' ? scheme : theme.scheme;
  const own = theme.tokens?.[effective];
  return {
    ...themeBackgrounds(theme, effective),
    track: own?.['--pt-track'] ?? SCHEME_INK[effective].track,
    text: own?.['--bs-body-color'] ?? SCHEME_INK[effective].text,
  };
}

/** Page and card background of a theme in a scheme (its tokens, or the built-in scheme's). */
export function themeBackgrounds(theme: ThemeDefinition, scheme: ColorScheme): { page: string; surface: string } {
  const own = theme.tokens?.[scheme];
  return {
    page: own?.['--pt-page-bg'] ?? SCHEME_BACKGROUNDS[scheme].page,
    surface: own?.['--pt-surface'] ?? SCHEME_BACKGROUNDS[scheme].surface,
  };
}

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

export function themeById(id: ThemeId): ThemeDefinition {
  return (THEMES as readonly ThemeDefinition[]).find((theme) => theme.id === id) ?? THEMES[0];
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
