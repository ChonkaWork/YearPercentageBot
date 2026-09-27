/** Whether the chat page is using a dark theme, so the in-page UI can match it. */
export function pageIsDark(doc: Document = document): boolean {
  const scheme = getComputedStyle(doc.documentElement).colorScheme.trim();
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  for (const element of [doc.body, doc.documentElement]) {
    if (!element) continue;
    const color = parseCssColor(getComputedStyle(element).backgroundColor);
    if (color && color.alpha > 0.5) return relativeLuminance(color) < 0.4;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** Parses computed colors: `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `rgb(1 2 3 / 50%)`. */
export function parseCssColor(value: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (!match) return null;
  const [, red = '0', green = '0', blue = '0', alpha] = match;
  const parsedAlpha = alpha === undefined ? 1 : alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
  return { red: Number(red), green: Number(green), blue: Number(blue), alpha: parsedAlpha };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ red, green, blue }: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}
