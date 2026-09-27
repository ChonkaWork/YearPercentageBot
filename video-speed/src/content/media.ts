import { classifyRateChange, FRESH_GUARD, tryReassert, type GuardState } from '../core/rateGuard';
import { clampSpeed, MIN_SPEED, sameSpeed } from '../core/speed';
import type { TargetCandidate } from '../core/target';

/** What a managed element needs from the rest of the content script. */
export interface MediaHost {
  /** Last trusted pointer/key input on the page (not our shortcuts or controller). */
  lastGestureAt(): number;
  /** Something visible changed (speed, playing state). */
  changed(media: ManagedMedia): void;
  /** The user changed the speed with the site's own controls. */
  adopted(media: ManagedMedia): void;
  /** The page keeps undoing our speed; we stopped correcting it. */
  gaveUp(media: ManagedMedia): void;
  /** The browser rejected a speed. */
  failed(media: ManagedMedia, error: unknown): void;
}

/** Events after which a rate change is the site resetting the player, and our speed is re-applied. */
const LIFECYCLE_EVENTS = ['loadstart', 'emptied', 'loadedmetadata', 'loadeddata', 'durationchange', 'canplay', 'play', 'playing'];
const EVENTS = [...LIFECYCLE_EVENTS, 'ratechange', 'pause', 'ended'];

/**
 * One <video>/<audio> element whose speed we may manage.
 *
 * `desired` is the speed we keep the element at; null means we leave it alone (it was never
 * changed and the remembered speed is 1×). The element's `playbackRate` is always read live,
 * so our own changes are recognized by value: when a ratechange arrives and the rate equals
 * `desired`, it's ours (or harmless).
 */
export class ManagedMedia {
  private static nextId = 1;
  readonly id = ManagedMedia.nextId++;
  desired: number | null = null;
  guard: GuardState = FRESH_GUARD;
  interactedAt = 0;
  startedAt = 0;
  private lastLifecycleAt = 0;
  private listening = false;

  constructor(
    readonly element: HTMLMediaElement,
    private readonly host: MediaHost,
  ) {}

  get kind(): 'video' | 'audio' {
    return this.element.localName === 'audio' ? 'audio' : 'video';
  }

  get speed(): number {
    return this.element.playbackRate;
  }

  get playing(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  /** Starts listening. A remembered speed other than 1× is applied right away. */
  attach(startSpeed: number): void {
    if (!this.listening) {
      for (const type of EVENTS) this.element.addEventListener(type, this.onEvent);
      this.listening = true;
    }
    if (!this.element.paused) this.startedAt = Date.now();
    if (this.desired === null && !sameSpeed(startSpeed, 1)) this.desired = clampSpeed(startSpeed);
    if (this.desired !== null && !sameSpeed(this.element.playbackRate, this.desired)) this.apply(this.desired);
  }

  detach(): void {
    for (const type of EVENTS) this.element.removeEventListener(type, this.onEvent);
    this.listening = false;
  }

  /** A speed the user picked (shortcut, controller, popup). Resets the correction budget. */
  setByUser(speed: number): boolean {
    this.desired = clampSpeed(speed);
    this.guard = FRESH_GUARD;
    this.interactedAt = Date.now();
    return this.apply(this.desired);
  }

  /** Stop managing (extension turned off here): the element keeps its current speed. */
  release(): void {
    this.desired = null;
    this.guard = FRESH_GUARD;
  }

  /** Moves the playback position (rewind/advance). */
  seekTo(time: number): void {
    this.interactedAt = Date.now();
    this.element.currentTime = time;
  }

  snapshot(visibleArea: number): TargetCandidate {
    return { interactedAt: this.interactedAt, startedAt: this.startedAt, playing: this.playing, visibleArea };
  }

  private apply(speed: number): boolean {
    try {
      this.element.playbackRate = speed;
      return true;
    } catch (error) {
      this.host.failed(this, error);
      return false;
    }
  }

  private readonly onEvent = (event: Event): void => {
    switch (event.type) {
      case 'ratechange':
        this.onRateChange();
        break;
      case 'pause':
      case 'ended':
        this.host.changed(this);
        break;
      default:
        this.onLifecycle(event.type);
    }
  };

  private onLifecycle(type: string): void {
    const now = Date.now();
    this.lastLifecycleAt = now;
    if (type === 'play') this.startedAt = now;
    // A new source is a fresh start: a page that fought the previous video may not fight this one.
    if (type === 'loadstart' || type === 'emptied') this.guard = FRESH_GUARD;
    // Re-applying on lifecycle events is driven by the media pipeline, not by our own writes,
    // so it can't loop and doesn't spend the correction budget.
    if (this.desired !== null && !this.guard.gaveUp && !sameSpeed(this.element.playbackRate, this.desired)) {
      this.apply(this.desired);
    }
    this.host.changed(this);
  }

  private onRateChange(): void {
    const now = Date.now();
    const actual = this.element.playbackRate;
    // Rate 0 (allowed by Chrome) is a site-specific trick, not a speed anyone picked.
    if (!(actual >= MIN_SPEED)) {
      this.host.changed(this);
      return;
    }
    const kind = classifyRateChange({
      now,
      actual,
      desired: this.desired,
      lastGestureAt: this.host.lastGestureAt(),
      lastLifecycleAt: this.lastLifecycleAt,
    });
    if (kind === 'user') {
      this.desired = actual;
      this.guard = FRESH_GUARD;
      this.host.adopted(this);
    } else if (kind === 'site' && this.desired !== null && !this.guard.gaveUp) {
      const result = tryReassert(this.guard, now);
      this.guard = result.state;
      if (result.allowed) this.apply(this.desired);
      else if (result.justGaveUp) this.host.gaveUp(this);
    }
    this.host.changed(this);
  }
}
