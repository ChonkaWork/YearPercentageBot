/**
 * Content script on www.youtube.com and m.youtube.com (top frame, document_start).
 *
 * Hiding itself is the static stylesheet from src/sites/youtube.ts (dist/content.css); this
 * script only decides what's on (core/focus.ts) and writes it to two attributes on <html>. It
 * also shows the calm home panel, performs the redirects, follows YouTube's SPA navigation and
 * re-checks at the pause end / schedule edges.
 */

import { sameChannel } from '../core/channels';
import { computeFocus, type Access, type Focus } from '../core/focus';
import { EARLY_ACCESS } from '../core/plan';
import { routeOf, watchVideoId } from '../core/routes';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import { applyClockChange, initClock, now } from '../platform/clock';
import { isPageRequest, type PageResponse } from '../platform/messages';
import { HIDE_ATTR, isDarkTheme, readWatchChannel, ROUTE_ATTR, type PageChannel } from '../sites/youtube';
import { isAccessChange, loadAccess, loadSettings, SETTINGS_KEY } from '../storage/store';
import { removePanel, updatePanel } from './panel';

const html = document.documentElement;
/** Longest wait between re-checks, so sleep/wake and clock changes are caught. */
const MAX_TIMER_MS = 60_000;
/** The same redirect isn't repeated within this window (guards against loops). */
const REDIRECT_GUARD_MS = 3000;

let settings: Settings = sanitizeSettings(DEFAULT_SETTINGS);
let access: Access = { plan: 'free', earlyAccess: EARLY_ACCESS };
let loaded = false;
let focus: Focus | null = null;
let channel: PageChannel | null = null;
let lastHref = location.href;
let timer: number | undefined;
let lastRedirect = { href: '', at: 0 };
let channelObserver: MutationObserver | null = null;
let channelCheck: number | undefined;
let stopped = false;
/** e2e build only: counts applies on <html data-ytf-e2e>, so tests can wait for a real apply. */
let applies = 0;

function contextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

// --- Applying ---------------------------------------------------------------------------------

function setAttr(name: string, value: string | null): void {
  if (value === null) {
    if (html.hasAttribute(name)) html.removeAttribute(name);
  } else if (html.getAttribute(name) !== value) {
    html.setAttribute(name, value);
  }
}

function writeAttributes(): void {
  if (!focus) return;
  setAttr(HIDE_ATTR, focus.hide.length ? focus.hide.join(' ') : null);
  setAttr(ROUTE_ATTR, focus.route);
}

/** Re-computes and applies. Redirects only follow page loads, navigation and the user's changes. */
function apply(allowRedirect: boolean): void {
  if (stopped) return;
  if (!contextAlive()) {
    stop();
    return;
  }
  const route = routeOf(location.pathname);
  if (route !== 'watch') channel = null;
  focus = computeFocus(settings, access, now(), { pathname: location.pathname, search: location.search, channel });
  writeAttributes();
  updatePanel(focus.calm && loaded, isDarkTheme(document));
  armTimer(focus.until);
  watchChannel(route === 'watch' && focus.state === 'on' && settings.allowlist.length > 0);
  if (__E2E__ && loaded) html.setAttribute('data-ytf-e2e', String(++applies));
  if (allowRedirect && focus.redirect && loaded) redirect(focus.redirect);
}

function armTimer(until: number | null): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (until === null) return;
  const delay = Math.min(MAX_TIMER_MS, Math.max(250, until - now() + 50));
  timer = window.setTimeout(() => apply(false), delay);
}

function redirect(path: string): void {
  const target = new URL(path, location.origin).href;
  if (target === location.href) return;
  const at = Date.now();
  if (lastRedirect.href === target && at - lastRedirect.at < REDIRECT_GUARD_MS) return;
  lastRedirect = { href: target, at };
  location.replace(target);
}

// --- The watch page's channel (allowlist) -----------------------------------------------------

function readChannel(): void {
  channelCheck = undefined;
  if (stopped) return;
  const next = readWatchChannel(document, watchVideoId(location.search));
  const changed = next === null ? channel !== null : channel === null || !sameChannel(channel, next);
  channel = next;
  if (changed) apply(false);
}

/** While on a watch page with an allowlist, follows the channel link as YouTube renders it. */
function watchChannel(on: boolean): void {
  if (!on) {
    channelObserver?.disconnect();
    channelObserver = null;
    return;
  }
  if (channelObserver) {
    // Already following: look once more (after a navigation the link may be there already).
    channelCheck ??= window.setTimeout(readChannel, 0);
    return;
  }
  channelObserver = new MutationObserver(() => {
    channelCheck ??= window.setTimeout(readChannel, 150);
  });
  channelObserver.observe(html, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'video-id'] });
  readChannel();
}

// --- Navigation -------------------------------------------------------------------------------

function onNavigate(): void {
  if (location.href === lastHref) return;
  const previous = new URL(lastHref);
  lastHref = location.href;
  if (previous.pathname !== location.pathname || watchVideoId(previous.search) !== watchVideoId(location.search)) channel = null;
  apply(true);
}

interface NavigationLike {
  addEventListener(type: 'currententrychange', listener: () => void): void;
  removeEventListener(type: 'currententrychange', listener: () => void): void;
}
const navigationApi = (window as unknown as { navigation?: NavigationLike }).navigation;
let pollTimer: number | undefined;

/** YouTube keeps our attributes, but a page script could wipe them: put them back. */
const attributeObserver = new MutationObserver(() => {
  writeAttributes();
  if (focus?.calm && loaded) updatePanel(true, isDarkTheme(document));
});

function start(): void {
  // YouTube fires yt-navigate-finish after each SPA navigation; the Navigation API and popstate
  // catch URL changes without it, and a slow poll is the last resort.
  window.addEventListener('yt-navigate-finish', onNavigate, true);
  window.addEventListener('popstate', onNavigate);
  navigationApi?.addEventListener('currententrychange', onNavigate);
  pollTimer = window.setInterval(onNavigate, 1000);
  attributeObserver.observe(html, { attributes: true, attributeFilter: [HIDE_ATTR, ROUTE_ATTR, 'dark', 'darker-dark-theme'] });
  chrome.storage.onChanged.addListener(onStorageChange);
  chrome.runtime.onMessage.addListener(onMessage);
}

/** The extension was reloaded or removed: leave YouTube exactly as it was. */
function stop(): void {
  stopped = true;
  window.clearTimeout(timer);
  window.clearTimeout(channelCheck);
  window.clearInterval(pollTimer);
  window.removeEventListener('yt-navigate-finish', onNavigate, true);
  window.removeEventListener('popstate', onNavigate);
  navigationApi?.removeEventListener('currententrychange', onNavigate);
  attributeObserver.disconnect();
  channelObserver?.disconnect();
  html.removeAttribute(HIDE_ATTR);
  html.removeAttribute(ROUTE_ATTR);
  removePanel();
}

// --- Settings and popup -----------------------------------------------------------------------

function onStorageChange(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== 'local' || stopped) return;
  let relevant = applyClockChange(changes);
  if (SETTINGS_KEY in changes) {
    settings = sanitizeSettings(changes[SETTINGS_KEY]?.newValue);
    relevant = true;
  }
  if (isAccessChange(changes)) {
    void loadAccess().then((next) => {
      access = next;
      apply(true);
    });
    return;
  }
  if (relevant) apply(true);
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: PageResponse) => void): void {
  if (!isPageRequest(message) || !focus) return;
  const current = focus.route === 'watch' ? readWatchChannel(document, watchVideoId(location.search)) : null;
  sendResponse({
    type: 'ytf/page-info',
    route: focus.route,
    channel: current,
    state: focus.state,
    hidden: focus.hide.length,
    channelAllowed: focus.channelAllowed,
  });
}

async function init(): Promise<void> {
  // Route first, synchronously, so route-gated rules are right from the first paint.
  setAttr(ROUTE_ATTR, routeOf(location.pathname));
  start();
  try {
    [settings, access] = await Promise.all([loadSettings(), loadAccess(), initClock()]);
  } catch {
    // Storage unavailable: keep the defaults (hide with the default switches).
  }
  loaded = true;
  apply(true);
}

void init();
