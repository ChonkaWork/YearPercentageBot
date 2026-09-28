/**
 * The one decision the content script and the popup share: given the settings, the plan, the
 * time and the page, what is hidden and where (if anywhere) the page should go. Pure.
 */

import { isAllowed, type ChannelRef } from './channels';
import { hasFeature, limitsFor, type Plan } from './plan';
import { routeOf, shortsVideoId, type Route } from './routes';
import { isInWindow, nextChange } from './schedule';
import { FEATURES, isPaused, type Feature, type Settings } from './settings';

/** What gets hidden: the free features, plus 'explore' (subscriptions-only mode). */
export type HideToken = Feature | 'explore';

export interface Access {
  plan: Plan;
  earlyAccess: boolean;
}

/**
 * on: hiding. off: master switch off. paused: "pause for 15 minutes".
 * outside-schedule: a Pro schedule is set and now is outside it.
 */
export type FocusState = 'on' | 'off' | 'paused' | 'outside-schedule';

export interface FocusStatus {
  state: FocusState;
  /** When the state is expected to change on its own (pause end, schedule edge); else null. */
  until: number | null;
}

export interface Focus extends FocusStatus {
  route: Route;
  /** Sorted, unique. Empty unless state is 'on'. */
  hide: HideToken[];
  /** Show the calm "home feed hidden" panel. */
  calm: boolean;
  /** Same-origin path + query to replace the page with, or null. */
  redirect: string | null;
  /** The current video's channel is on the (honored) allowlist. */
  channelAllowed: boolean;
}

export interface PageInfo {
  pathname: string;
  search: string;
  /** Channel of the video on a watch page, when known. */
  channel: ChannelRef | null;
}

export const SUBSCRIPTIONS_PATH = '/feed/subscriptions';

export function focusStatus(settings: Settings, access: Access, now: number): FocusStatus {
  if (!settings.enabled) return { state: 'off', until: null };
  if (isPaused(settings, now)) return { state: 'paused', until: settings.pausedUntil };
  const schedule = settings.schedule;
  if (schedule.enabled && hasFeature(access.plan, 'schedule', access.earlyAccess)) {
    const inside = isInWindow(schedule, now);
    return { state: inside ? 'on' : 'outside-schedule', until: nextChange(schedule, now) };
  }
  return { state: 'on', until: null };
}

export function subscriptionsOnly(settings: Settings, access: Access): boolean {
  return settings.subscriptionsOnly && hasFeature(access.plan, 'subscriptions-only', access.earlyAccess);
}

export function channelAllowed(settings: Settings, access: Access, channel: ChannelRef | null): boolean {
  const { maxAllowedChannels } = limitsFor(access.plan, access.earlyAccess);
  return maxAllowedChannels > 0 && isAllowed(settings.allowlist, channel, maxAllowedChannels);
}

/** Hidden on videos from allowlisted channels: these come back. */
const ALLOWLIST_RELAXES: readonly HideToken[] = ['comments', 'related', 'endscreen'];

export function computeFocus(settings: Settings, access: Access, now: number, page: PageInfo): Focus {
  const status = focusStatus(settings, access, now);
  const route = routeOf(page.pathname);
  const allowed = route === 'watch' && channelAllowed(settings, access, page.channel);
  const result: Focus = { ...status, route, hide: [], calm: false, redirect: null, channelAllowed: allowed };
  if (status.state !== 'on') return result;

  const strict = subscriptionsOnly(settings, access);
  const hide = new Set<HideToken>(strict ? [...FEATURES, 'explore'] : FEATURES.filter((feature) => settings.hide[feature]));
  if (allowed) for (const token of ALLOWLIST_RELAXES) hide.delete(token);
  result.hide = [...hide].sort();

  if (route === 'shorts' && hide.has('shorts')) {
    const id = shortsVideoId(page.pathname);
    // A Short opened from a link plays as a normal video instead of the Shorts feed.
    if (id) result.redirect = `/watch?v=${id}`;
  } else if (route === 'home' && hide.has('home') && (strict || settings.homeMode === 'subscriptions')) {
    result.redirect = SUBSCRIPTIONS_PATH;
  } else if (route === 'explore' && strict) {
    result.redirect = SUBSCRIPTIONS_PATH;
  }
  result.calm = route === 'home' && hide.has('home') && result.redirect === null;
  return result;
}

/** Same hide list, calm flag and redirect: nothing on the page needs to change. */
export function sameEffect(a: Focus | null, b: Focus): boolean {
  return (
    a !== null &&
    a.route === b.route &&
    a.calm === b.calm &&
    a.redirect === b.redirect &&
    a.hide.length === b.hide.length &&
    a.hide.every((token, index) => token === b.hide[index])
  );
}
