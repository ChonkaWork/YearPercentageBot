import css from '../styles/inpage.scss';

/**
 * In-page UI (toast, outline, recording bar) lives in closed shadow roots (open in the e2e
 * build) so the page's CSS can't touch it and it can't touch the page. The stylesheet is
 * adopted (works under strict page CSP); page content only ever reaches it as text.
 */

let sheet: CSSStyleSheet | null = null;

export interface ShadowHost {
  host: HTMLElement;
  root: ShadowRoot;
}

/** A host element pinned to the top-left corner of the viewport, above everything. */
export function createShadowHost(tag: string, zIndex = 2147483647): ShadowHost {
  const host = document.createElement(tag);
  host.style.cssText = `all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: ${zIndex} !important; display: block !important;`;
  const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  try {
    sheet ??= new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
  return { host, root };
}
