import { sameSpeed } from './speed';

/**
 * Deciding what to do when a video's `playbackRate` changes and we didn't do it.
 *
 * Sites like YouTube reset the rate to 1 when a new video or an ad loads, or on play. Users
 * can also change the speed with the site's own menu. Rules:
 *  - Right after a media lifecycle event (loadstart, loadedmetadata, play, ...) a change is the
 *    site resetting the player → we put our speed back ("site").
 *  - Otherwise, right after the user clicked or pressed a key on the page, it's the user using
 *    the site's controls → we adopt the new speed ("user").
 *  - Otherwise it's a script → put our speed back ("site").
 * Corrections are rate-limited: a page that keeps undoing them would otherwise loop forever
 * (our set → their ratechange handler → our set …). After `maxReasserts` corrections within
 * `windowMs` we stop and tell the user.
 */

export const RATE_GUARD = Object.freeze({
  lifecycleMs: 1500,
  gestureMs: 1000,
  windowMs: 3000,
  maxReasserts: 4,
});

export type RateGuardConfig = typeof RATE_GUARD;

export type RateChangeKind =
  /** The element is at the speed we want (our own change, or someone agreed with us). */
  | 'in-sync'
  /** We don't manage this element's speed and the user didn't cause it: leave it alone. */
  | 'unmanaged'
  /** The user changed it with the site's own controls: adopt it. */
  | 'user'
  /** The site changed it on its own: put ours back (within budget). */
  | 'site';

export interface RateChangeInput {
  now: number;
  /** playbackRate right now. */
  actual: number;
  /** Speed we maintain for this element, null when we don't manage it. */
  desired: number | null;
  /** Last trusted pointer/key input on the page, excluding our own shortcuts and controller. */
  lastGestureAt: number;
  /** Last lifecycle event of this element (loadstart, loadedmetadata, play, ...). */
  lastLifecycleAt: number;
}

export function classifyRateChange(input: RateChangeInput, config: RateGuardConfig = RATE_GUARD): RateChangeKind {
  if (input.desired !== null && sameSpeed(input.actual, input.desired)) return 'in-sync';
  const lifecycle = input.now - input.lastLifecycleAt <= config.lifecycleMs;
  const gesture = input.now - input.lastGestureAt <= config.gestureMs;
  if (gesture && !lifecycle) return 'user';
  return input.desired === null ? 'unmanaged' : 'site';
}

export interface GuardState {
  /** Timestamps of recent corrections. */
  reasserts: readonly number[];
  /** Budget exhausted: no more corrections until the user sets a speed or a new source loads. */
  gaveUp: boolean;
}

export const FRESH_GUARD: GuardState = Object.freeze({ reasserts: Object.freeze([]) as readonly number[], gaveUp: false });

/** Spends one correction from the budget, or reports that the budget is exhausted. */
export function tryReassert(
  state: GuardState,
  now: number,
  config: RateGuardConfig = RATE_GUARD,
): { allowed: boolean; state: GuardState; justGaveUp: boolean } {
  if (state.gaveUp) return { allowed: false, state, justGaveUp: false };
  const recent = state.reasserts.filter((time) => now - time < config.windowMs);
  if (recent.length >= config.maxReasserts) {
    return { allowed: false, state: { reasserts: recent, gaveUp: true }, justGaveUp: true };
  }
  return { allowed: true, state: { reasserts: [...recent, now], gaveUp: false }, justGaveUp: false };
}
