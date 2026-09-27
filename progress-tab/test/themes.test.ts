import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACCENTS,
  SCHEME_BACKGROUNDS,
  THEMES,
  contrastRatio,
  hexToRgb,
  resolveScheme,
  themeVariables,
  type ColorScheme,
  type ThemeDefinition,
} from '../src/core/themes';

const schemes: ColorScheme[] = ['light', 'dark'];

describe('registry', () => {
  it('has unique ids', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(ACCENTS.length);
  });

  it('starts with the brand mint accent', () => {
    expect(ACCENTS[0].id).toBe('mint');
    expect(ACCENTS[0].light.fill).toBe('#0ca678');
  });
});

describe('every accent is readable in both schemes', () => {
  for (const accent of ACCENTS) {
    for (const scheme of schemes) {
      it(`${accent.id} / ${scheme}`, () => {
        const palette = accent[scheme];
        // Fills (bars, checked switches) only appear on cards and panels.
        expect(contrastRatio(palette.fill, SCHEME_BACKGROUNDS[scheme].surface), 'fill on surface').toBeGreaterThanOrEqual(3);
        for (const background of Object.values(SCHEME_BACKGROUNDS[scheme])) {
          expect(contrastRatio(palette.text, background), `text on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(palette.text, palette.subtle), 'text on subtle').toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.onSolid, palette.solid), 'button text').toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.onSolid, palette.solidHover), 'button text on hover').toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('themeVariables', () => {
  it('maps an accent to CSS custom properties', () => {
    const vars = themeVariables(THEMES[0], ACCENTS[0], 'light');
    expect(vars['--pt-accent']).toBe('#0ca678');
    expect(vars['--pt-accent-rgb']).toBe('12, 166, 120');
    expect(vars['--pt-accent-on-solid']).toBe('#ffffff');
  });

  it('includes theme tokens for the active scheme (for future themes)', () => {
    const paper: ThemeDefinition = {
      id: 'paper',
      label: 'Paper',
      tier: 'free',
      scheme: 'light',
      tokens: { light: { '--pt-page-bg': '#f5efe6' } },
    };
    expect(themeVariables(paper, ACCENTS[1], 'light')['--pt-page-bg']).toBe('#f5efe6');
    expect(themeVariables(paper, ACCENTS[1], 'dark')['--pt-page-bg']).toBeUndefined();
  });

  it('resolves auto from the OS preference', () => {
    expect(resolveScheme(THEMES[0], true)).toBe('dark');
    expect(resolveScheme(THEMES[0], false)).toBe('light');
    expect(resolveScheme(THEMES[2], false)).toBe('dark');
    expect(resolveScheme(THEMES[1], true)).toBe('light');
  });
});

describe('color math', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(hexToRgb('#0ca678')).toEqual([12, 166, 120]);
    expect(() => hexToRgb('mint')).toThrow();
  });

  it('matches the backgrounds in _theme.scss', () => {
    const themeScss = readFileSync(new URL('../src/styles/_theme.scss', import.meta.url), 'utf8');
    const value = (name: string) => new RegExp(`\\$${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(themeScss)?.[1]?.toLowerCase();
    expect(value('pt-page-bg')).toBe(SCHEME_BACKGROUNDS.light.page);
    expect(value('pt-surface')).toBe(SCHEME_BACKGROUNDS.light.surface);
    expect(value('pt-page-bg-dark')).toBe(SCHEME_BACKGROUNDS.dark.page);
    expect(value('pt-surface-dark')).toBe(SCHEME_BACKGROUNDS.dark.surface);
  });
});
