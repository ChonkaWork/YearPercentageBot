import eyeSlash from 'bootstrap-icons/icons/eye-slash.svg';
import panelCss from '../styles/panel.scss';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';

/**
 * The calm panel shown where the home feed was: one sentence and two ways to carry on.
 * Lives in its own shadow root (closed in production), fixed over the empty page, so YouTube's
 * re-renders can't remove it and its CSS can't touch YouTube.
 */

const TAG = 'youtube-focus-panel';
let host: HTMLElement | null = null;

function create(): HTMLElement {
  const element = document.createElement(TAG);
  const root = element.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(panelCss);
  root.adoptedStyleSheets = [sheet];
  root.append(
    h(
      'div',
      { class: 'card', attrs: { role: 'region', 'aria-label': 'YouTube Focus' } },
      h('span', { class: 'icon' }, icon(eyeSlash, { size: 22 })),
      h('h2', { text: 'Your home feed is hidden' }),
      h('p', { text: 'Search for what you came for, or catch up with the channels you follow.' }),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'primary', text: 'Subscriptions', attrs: { href: '/feed/subscriptions' } }),
        h('a', { text: 'Watch later', attrs: { href: '/playlist?list=WL' } }),
      ),
      h('p', { class: 'note', text: 'Hidden by YouTube Focus. Change it from the toolbar button.' }),
    ),
  );
  return element;
}

export function updatePanel(show: boolean, dark: boolean): void {
  if (!show) {
    host?.remove();
    return;
  }
  host ??= create();
  host.dataset.theme = dark ? 'dark' : 'light';
  if (!host.isConnected) document.documentElement.append(host);
}

export function removePanel(): void {
  host?.remove();
  host = null;
}
