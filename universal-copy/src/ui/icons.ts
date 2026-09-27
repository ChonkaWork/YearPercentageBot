/**
 * Bootstrap Icons are bundled as SVG text (esbuild's text loader) and parsed as XML into
 * inline SVG elements. Only our own static icon files go through here, never page content.
 */
export function svgIcon(source: string, size = 16, label?: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
  const svg = document.importNode(parsed, true) as unknown as SVGSVGElement;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.removeAttribute('class');
  svg.classList.add('bi');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  return svg;
}
