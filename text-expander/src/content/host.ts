/**
 * In-page UI lives in closed shadow roots appended to <html> (outside <body>, which may itself
 * be an editor), styled through adoptedStyleSheets, which works under strict page CSPs.
 */

import css from '../styles/inpage.scss?inline';

let sheet: CSSStyleSheet | null = null;
export function inpageStyles(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  return sheet;
}

export function createHost(tag: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0;';
  // Open only in the test build, so the e2e test can look inside.
  const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  root.adoptedStyleSheets = [inpageStyles()];
  return { host, root };
}

const GAP = 6;
const MARGIN = 8;

/**
 * Puts `host` under the caret rectangle `anchor` (viewport coordinates), or above it when
 * there is no room below, keeping it inside the viewport.
 */
export function placeNear(host: HTMLElement, panel: HTMLElement, anchor: DOMRect): 'below' | 'above' {
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const left = Math.min(Math.max(MARGIN, anchor.left), maxLeft);
  let top = anchor.bottom + GAP;
  let side: 'below' | 'above' = 'below';
  if (top + height > window.innerHeight - MARGIN && anchor.top - GAP - height >= MARGIN) {
    top = anchor.top - GAP - height;
    side = 'above';
  }
  top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
  return side;
}
