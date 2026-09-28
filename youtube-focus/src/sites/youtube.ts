/**
 * Every YouTube selector the extension relies on, in one place.
 *
 * UNVERIFIED: YouTube's pages can't be reached from the environment this was built in. These
 * selectors follow YouTube's long-standing custom element names (ytd-* on www., ytm-* on m.),
 * checked only against the local fixtures in e2e/fixtures/ that copy that structure. When
 * YouTube changes its markup, this file is the only one to fix. The README lists them too.
 *
 * Hiding is pure CSS: scripts/build.mjs turns HIDE_RULES into dist/content.css, which Chrome
 * injects before the page renders. Every rule is gated on attributes the content script sets on
 * <html> (`data-ytf-hide="shorts home …"`, `data-ytf-route="home"`), so switching a setting only
 * changes an attribute: nothing is removed from YouTube's DOM and nothing needs a reload.
 */

import type { ChannelRef } from '../core/channels';
import { channelFromHref } from '../core/channels';
import type { HideToken } from '../core/focus';
import type { Route } from '../core/routes';

export const HIDE_ATTR = 'data-ytf-hide';
export const ROUTE_ATTR = 'data-ytf-route';

export interface HideRule {
  token: HideToken;
  /** Only on these pages (by URL); every page when absent. */
  routes?: readonly Route[];
  /** One CSS rule each, so a selector Chrome rejects doesn't take the others down. */
  selectors: readonly string[];
}

export const HIDE_RULES: readonly HideRule[] = [
  {
    token: 'shorts',
    selectors: [
      // www.youtube.com
      'ytd-reel-shelf-renderer', // Shorts shelf in search, next to videos, on channel pages
      'ytd-rich-shelf-renderer[is-shorts]', // Shorts shelf in the home / subscriptions grid
      'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])', // …and its grid row
      'ytd-guide-entry-renderer:has(a#endpoint[title="Shorts"])', // sidebar entry
      'ytd-mini-guide-entry-renderer[aria-label="Shorts"]', // collapsed sidebar entry
      'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
      'ytd-rich-item-renderer:has(a[href^="/shorts/"])', // a Short in the subscriptions grid
      'ytd-grid-video-renderer:has(a[href^="/shorts/"])', // older grid layout
      'ytd-video-renderer:has(a[href^="/shorts/"])', // a Short as a search result row
      'ytd-reel-item-renderer', // Shorts tile
      'ytm-shorts-lockup-view-model', // newer Shorts tile (also used on www.)
      'ytm-shorts-lockup-view-model-v2',
      'grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)', // newer Shorts shelf
      'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
      'yt-tab-shape[tab-title="Shorts"]', // Shorts tab on channel pages
      // m.youtube.com
      'ytm-reel-shelf-renderer',
      'ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)',
      'ytm-pivot-bar-item-renderer:has(.pivot-shorts)', // bottom bar tab
      'ytm-video-with-context-renderer:has(a[href^="/shorts/"])',
      'ytm-rich-item-renderer:has(a[href^="/shorts/"])',
    ],
  },
  {
    token: 'home',
    routes: ['home'],
    selectors: [
      'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', // the feed, with its chip bar
      'ytm-browse ytm-rich-grid-renderer',
      'ytm-browse ytm-section-list-renderer',
      'ytm-browse ytm-feed-filter-chip-bar-renderer',
    ],
  },
  {
    token: 'related',
    routes: ['watch'],
    selectors: [
      'ytd-watch-flexy #related', // "Up next" column (and below the player in narrow windows)
      'ytd-watch-next-secondary-results-renderer',
      'ytm-item-section-renderer[section-identifier="related-items"]',
      'ytm-single-column-watch-next-results-renderer ytm-item-section-renderer[data-content-type="related"]',
    ],
  },
  {
    token: 'endscreen',
    // The player can keep playing in the miniplayer on other pages.
    selectors: [
      '.html5-video-player .ytp-ce-element', // end-screen cards over the last seconds
      '.html5-video-player .ytp-endscreen-content', // grid of suggested videos when it ends
      '.html5-video-player .videowall-endscreen',
      '.html5-video-player .ytp-autonav-endscreen-countdown-overlay', // "Up next in 5" autoplay card
      '.html5-video-player .ytp-cards-teaser', // info-card teasers
      '.html5-video-player .ytp-pause-overlay', // "More videos" while paused
    ],
  },
  {
    token: 'comments',
    selectors: [
      'ytd-comments#comments',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
      'ytm-comment-section-renderer',
      'ytm-comments-entry-point-header-renderer',
    ],
  },
  {
    token: 'explore',
    selectors: [
      'ytd-guide-section-renderer:has(a[href="/feed/trending"])', // sidebar "Explore" section
      'ytd-guide-entry-renderer:has(a#endpoint[href="/"])', // sidebar Home
      'ytd-mini-guide-entry-renderer:has(a[href="/"])',
      'ytd-mini-guide-entry-renderer:has(a[href="/feed/trending"])',
      'ytd-search ytd-shelf-renderer', // "People also watched", "For you" in search results
      'ytd-search ytd-horizontal-card-list-renderer', // "People also search for"
      'ytm-pivot-bar-item-renderer:has(.pivot-w2w)', // m. bottom bar Home
    ],
  },
];

const DECLARATION = '{display:none!important}';

/** The stylesheet for dist/content.css. */
export function buildHideCss(rules: readonly HideRule[] = HIDE_RULES): string {
  const lines = ['/* YouTube Focus: generated from src/sites/youtube.ts. Hides only what <html data-ytf-hide> names. */'];
  for (const rule of rules) {
    const gates = (rule.routes ?? [null]).map(
      (route) => `html[${HIDE_ATTR}~="${rule.token}"]${route ? `[${ROUTE_ATTR}="${route}"]` : ''}`,
    );
    for (const gate of gates) for (const selector of rule.selectors) lines.push(`${gate} ${selector}${DECLARATION}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- Reading the page -------------------------------------------------------------------------

/** Links to the channel of the video being watched (first match wins). */
export const CHANNEL_LINK_SELECTORS = [
  'ytd-watch-metadata ytd-channel-name a[href]',
  'ytd-watch-metadata #owner a[href]',
  'ytd-video-owner-renderer ytd-channel-name a[href]',
  'ytm-slim-owner-renderer a[href]',
  'ytm-slim-owner-renderer [href]',
] as const;

/** Element carrying the id of the video its metadata belongs to (www. only). */
export const WATCH_ROOT_SELECTOR = 'ytd-watch-flexy[video-id]';

/** YouTube's own dark theme, for the calm panel. */
export const DARK_THEME_ATTRS = ['dark', 'darker-dark-theme'] as const;

export interface PageChannel extends ChannelRef {
  name: string;
}

/**
 * The channel of the video on a watch page, or null while it isn't rendered yet. YouTube keeps
 * the previous video's metadata during SPA navigation, so on www. it is only trusted once the
 * player's `video-id` matches the URL.
 */
export function readWatchChannel(doc: Document, videoId: string | null): PageChannel | null {
  const root = doc.querySelector(WATCH_ROOT_SELECTOR);
  if (root && videoId && root.getAttribute('video-id') !== videoId) return null;
  for (const selector of CHANNEL_LINK_SELECTORS) {
    for (const link of doc.querySelectorAll(selector)) {
      const channel = channelFromHref(link.getAttribute('href') ?? '');
      if (!channel) continue;
      const name = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
      return { ...channel, name };
    }
  }
  return null;
}

export function isDarkTheme(doc: Document): boolean {
  return DARK_THEME_ATTRS.some((attr) => doc.documentElement.hasAttribute(attr));
}
