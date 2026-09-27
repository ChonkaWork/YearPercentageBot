/**
 * Bootstrap Icons are bundled as SVG source text (trusted, from node_modules at build time)
 * and parsed with DOMParser, so no innerHTML is involved anywhere.
 */

const cache = new Map<string, SVGSVGElement>();

export function svgIcon(source: string, className = ''): SVGSVGElement {
  let template = cache.get(source);
  if (!template) {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    if (!(parsed instanceof SVGSVGElement)) throw new Error('Invalid icon');
    parsed.removeAttribute('width');
    parsed.removeAttribute('height');
    parsed.removeAttribute('class');
    parsed.setAttribute('aria-hidden', 'true');
    parsed.setAttribute('focusable', 'false');
    template = parsed;
    cache.set(source, template);
  }
  const icon = document.importNode(template, true);
  icon.setAttribute('class', `bi${className ? ` ${className}` : ''}`);
  return icon;
}
