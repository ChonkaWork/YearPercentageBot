import { blockingEntry, siteHostOf } from '../core/hosts';
import { isTypingTarget, keyLabel, matchShortcut, type ActionId, type KeyTargetLike } from '../core/keys';
import {
  GLOBAL_SPEED_KEY,
  parseGlobalSpeed,
  parseSiteSpeed,
  resolveStartSpeed,
  siteSpeedKey,
  type RememberedSpeeds,
} from '../core/memory';
import { EARLY_ACCESS } from '../core/plan';
import { sanitizeSettings, type Settings } from '../core/settings';
import { siteDefaultFor } from '../core/siteDefaults';
import { clampSpeed, DEFAULT_SPEED, formatSpeed, seekTarget, stepSpeed, togglePreferred } from '../core/speed';
import { pickTarget, visibleAreaOf } from '../core/target';
import {
  isContentRequest,
  type Command,
  type CommandResponse,
  type FrameReport,
  type FrameStatus,
  type MediaSummary,
} from '../platform/messages';
import {
  can,
  isAccessChange,
  loadAccess,
  loadRememberedSpeeds,
  loadSettings,
  saveRememberedSpeed,
  SETTINGS_KEY,
  type Access,
} from '../storage/store';
import { MediaScanner } from './discovery';
import { ManagedMedia, type MediaHost } from './media';
import { Overlay, type ControllerAction } from './overlay';

const SAVE_DEBOUNCE_MS = 400;
const TICK_MS = 1000;

type Source = 'keyboard' | 'controller' | 'popup';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deepest focused element, looking into open and closed shadow roots. */
function deepActiveElement(): Element | null {
  let element: Element | null = document.activeElement;
  for (let depth = 0; element && depth < 16; depth += 1) {
    let root: ShadowRoot | null = element.shadowRoot;
    if (!root) {
      try {
        root = chrome.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? null;
      } catch {
        root = null;
      }
    }
    const inner = root?.activeElement ?? null;
    if (!inner) break;
    element = inner;
  }
  return element;
}

function targetInfo(node: unknown): KeyTargetLike | null {
  if (!(node instanceof Element)) return null;
  return {
    tagName: node.tagName,
    isContentEditable: node instanceof HTMLElement && node.isContentEditable,
    role: node.getAttribute('role'),
  };
}

/**
 * The content script, one instance per frame. Stays dormant (no listeners except messages
 * and settings) on blocklisted sites. Reads nothing from the page except media elements,
 * key presses (to match shortcuts) and pointer positions (to know which video you use).
 */
export class App {
  private settings: Settings = sanitizeSettings(undefined);
  private remembered: RememberedSpeeds = { global: null, site: null };
  private access: Access = { plan: 'free', earlyAccess: EARLY_ACCESS };
  private readonly frameHost = location.hostname.toLowerCase();
  private readonly site = siteHostOf(location.hostname, Array.from(location.ancestorOrigins ?? []));
  private readonly isTop = window.top === window;
  private active = false;
  private destroyed = false;
  private blockedBy: string | null = null;
  private problem: string | null = null;
  private readonly registry = new WeakMap<HTMLMediaElement, ManagedMedia>();
  private readonly tracked = new Set<ManagedMedia>();
  private readonly overlay: Overlay;
  private readonly scanner: MediaScanner;
  private gestureAt = 0;
  private controllersVisible = true;
  private readonly swallowedKeyups = new Set<string>();
  private tickTimer: number | null = null;
  private saveTimer: number | null = null;
  private pendingSave: number | null = null;
  private pendingNewSite = false;

  private readonly mediaHost: MediaHost = {
    lastGestureAt: () => this.gestureAt,
    changed: (media) => this.overlay.update(media),
    adopted: (media) => {
      this.remember(media.speed);
      this.overlay.update(media, true);
    },
    gaveUp: (media) =>
      this.report(media, 'This page keeps changing the speed back, so Video Speed+ stopped overriding it. Set the speed again to retry.'),
    failed: (media, error) => this.report(media, `The browser rejected this speed: ${errorMessage(error)}`),
  };

  constructor() {
    this.overlay = new Overlay({
      action: (media, action) => this.onControllerAction(media, action),
      label: (action) => this.controllerLabel(action),
    });
    this.scanner = new MediaScanner(
      (element) => this.track(element),
      () => this.settings.includeAudio,
      (node) => this.overlay.isOwnNode(node),
    );
  }

  async start(): Promise<void> {
    chrome.runtime.onMessage.addListener(this.onMessage);
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    try {
      this.settings = await loadSettings();
      this.remembered = await loadRememberedSpeeds(this.site);
      this.access = await loadAccess();
    } catch (error) {
      if (!this.alive()) return;
      this.settings = sanitizeSettings(undefined);
      this.problem = `Couldn't read settings, using defaults: ${errorMessage(error)}`;
    }
    this.controllersVisible = this.settings.showController;
    this.overlay.setControllersVisible(this.controllersVisible);
    this.updateActivation();
  }

  /** Removes every trace from the page (the extension was reloaded or a newer copy took over). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.deactivate();
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
      chrome.storage.onChanged.removeListener(this.onStorageChanged);
    } catch {
      // The extension context is already gone; its listeners went with it.
    }
  }

  // --- Activation (blocklist) -----------------------------------------------------------------

  private updateActivation(): void {
    this.blockedBy = blockingEntry(this.settings.blocklist, this.site) ?? blockingEntry(this.settings.blocklist, this.frameHost);
    if (this.blockedBy === null) this.activate();
    else this.deactivate();
  }

  private activate(): void {
    if (this.active || this.destroyed) return;
    this.active = true;
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('pointerdown', this.onPointerDown, true);
    this.scanner.start();
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    this.scanner.stop();
    for (const media of this.tracked) {
      media.detach();
      media.release();
    }
    this.tracked.clear();
    this.overlay.destroy();
    this.stopTick();
  }

  private alive(): boolean {
    try {
      if (chrome.runtime?.id) return true;
    } catch {
      // Accessing chrome.runtime throws in some invalidated contexts.
    }
    this.destroy();
    return false;
  }

  // --- Tracking ---------------------------------------------------------------------------------

  private track(element: HTMLMediaElement): void {
    if (!this.active) return;
    if (element.localName === 'audio' && !this.settings.includeAudio) return;
    let media = this.registry.get(element);
    if (media && this.tracked.has(media)) return;
    if (!media) {
      media = new ManagedMedia(element, this.mediaHost);
      this.registry.set(element, media);
    }
    this.tracked.add(media);
    media.attach(this.startSpeed());
    this.overlay.add(media);
    this.startTick();
  }

  private untrack(media: ManagedMedia): void {
    media.detach();
    this.tracked.delete(media);
    this.overlay.remove(media);
  }

  private startSpeed(): number {
    return resolveStartSpeed(this.remembered, this.settings.rememberPerSite, this.site, this.siteDefault());
  }

  /** Pro: the default speed set for this site, or null (no rule, or the plan doesn't include it). */
  private siteDefault(): number | null {
    if (!this.site || !can(this.access, 'site-defaults')) return null;
    return siteDefaultFor(this.settings.siteDefaults, this.site)?.speed ?? null;
  }

  private startTick(): void {
    if (this.tickTimer === null) this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** Drops elements that left the page (kept in the registry in case they come back) and re-lays out. */
  private tick(): void {
    for (const media of this.tracked) if (!media.element.isConnected) this.untrack(media);
    if (!this.tracked.size) {
      this.stopTick();
      return;
    }
    if (document.visibilityState === 'visible') this.overlay.layout();
  }

  private connectedMedia(): ManagedMedia[] {
    return [...this.tracked].filter((media) => media.element.isConnected);
  }

  private visibleArea(media: ManagedMedia): number {
    return visibleAreaOf(media.element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  }

  /** The element shortcuts and the popup control. See core/target.ts for the rule. */
  private target(): ManagedMedia | null {
    const candidates = this.connectedMedia().map((media) => ({ media, ...media.snapshot(this.visibleArea(media)) }));
    return pickTarget(candidates)?.media ?? null;
  }

  /** The smallest tracked element under a point (players can nest a preview inside a player). */
  private mediaAt(x: number, y: number): ManagedMedia | null {
    let found: ManagedMedia | null = null;
    let foundArea = Number.POSITIVE_INFINITY;
    for (const media of this.connectedMedia()) {
      const rect = media.element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom && area < foundArea) {
        found = media;
        foundArea = area;
      }
    }
    return found;
  }

  // --- Input ------------------------------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!event.isTrusted || !this.alive()) return;
    // Letters must reach fields and editors: check both the event origin and the focused
    // element (they differ when focus is inside a closed shadow root).
    const typing = isTypingTarget(targetInfo(event.composedPath()[0])) || isTypingTarget(targetInfo(deepActiveElement()));
    const match = typing ? null : matchShortcut(this.settings.keys, event, null);
    if (!match) {
      this.gestureAt = Date.now();
      return;
    }
    if (match.action === 'toggleController') {
      if (!this.connectedMedia().some((media) => media.kind === 'video')) {
        this.gestureAt = Date.now();
        return;
      }
      this.consume(event);
      if (!match.repeatOnly) this.toggleControllers(this.target());
      return;
    }
    let media = this.target();
    if (!media) {
      this.scanner.deepScan();
      media = this.target();
    }
    if (!media) {
      // Nothing to control in this frame: the key belongs to the page.
      this.gestureAt = Date.now();
      return;
    }
    this.consume(event);
    if (!match.repeatOnly) this.run(match.action, media, 'keyboard');
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.swallowedKeyups.delete(event.code)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  /** Our shortcut: the page never sees it (e.g. YouTube's own "d"/"s" handling, if any). */
  private consume(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.swallowedKeyups.add(event.code);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || this.overlay.isOwnEvent(event)) return;
    const now = Date.now();
    this.gestureAt = now;
    const media = this.mediaAt(event.clientX, event.clientY);
    if (media) media.interactedAt = now;
  };

  // --- Actions ----------------------------------------------------------------------------------

  private run(action: ActionId, media: ManagedMedia, source: Source): void {
    const { step, preferredSpeed, seekSeconds } = this.settings;
    switch (action) {
      case 'slower':
        this.setSpeed(media, stepSpeed(media.speed, -step), source);
        break;
      case 'faster':
        this.setSpeed(media, stepSpeed(media.speed, step), source);
        break;
      case 'reset':
        this.setSpeed(media, DEFAULT_SPEED, source);
        break;
      case 'preferred':
        this.setSpeed(media, togglePreferred(media.speed, preferredSpeed), source);
        break;
      case 'rewind':
        this.seek(media, -seekSeconds, source);
        break;
      case 'advance':
        this.seek(media, seekSeconds, source);
        break;
      case 'toggleController':
        this.toggleControllers(media);
        break;
    }
  }

  private setSpeed(media: ManagedMedia, speed: number, source: Source): boolean {
    if (!media.setByUser(speed)) return false;
    this.problem = null;
    this.remember(media.speed);
    this.overlay.update(media, true);
    if (source === 'keyboard') this.overlay.flash(media, formatSpeed(media.speed));
    return true;
  }

  private seek(media: ManagedMedia, delta: number, source: Source): void {
    const element = media.element;
    try {
      media.seekTo(seekTarget(element.currentTime, delta, element.duration));
    } catch (error) {
      this.report(media, `Couldn't seek: ${errorMessage(error)}`);
      return;
    }
    if (source === 'keyboard') this.overlay.flash(media, `${delta < 0 ? '−' : '+'}${Math.abs(delta)} s`);
  }

  private toggleControllers(media: ManagedMedia | null): void {
    this.controllersVisible = !this.controllersVisible;
    this.overlay.setControllersVisible(this.controllersVisible);
    const key = this.settings.keys.toggleController;
    const hint = this.controllersVisible
      ? 'Controller shown'
      : key
        ? `Controller hidden · press ${keyLabel(key)} to show`
        : 'Controller hidden · reload the page to show it';
    this.overlay.flash(media, hint, 'hint');
  }

  private onControllerAction(media: ManagedMedia, action: ControllerAction): void {
    if (!this.active) return;
    media.interactedAt = Date.now();
    if (action === 'hide') this.toggleControllers(media);
    else this.run(action, media, 'controller');
  }

  private controllerLabel(action: ControllerAction): string {
    const names: Record<ControllerAction, [string, ActionId]> = {
      slower: ['Slower', 'slower'],
      faster: ['Faster', 'faster'],
      reset: ['Reset to 1×', 'reset'],
      hide: ['Hide controller', 'toggleController'],
    };
    const [name, id] = names[action];
    const key = this.settings.keys[id];
    return key ? `${name} (${keyLabel(key)})` : name;
  }

  private report(media: ManagedMedia | null, message: string): void {
    this.problem = message;
    this.overlay.flash(media, message, 'warning');
  }

  // --- Memory -----------------------------------------------------------------------------------

  private remember(speed: number): void {
    const value = clampSpeed(speed);
    const perSite = this.settings.rememberPerSite && this.site !== '';
    // First entry for this site: the save prunes the oldest site entries.
    if (perSite && this.remembered.site === null) this.pendingNewSite = true;
    this.pendingSave = value;
    this.remembered = {
      global: value,
      site: perSite ? { speed: value, at: Date.now() } : this.remembered.site,
    };
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  private async flushSave(): Promise<void> {
    this.saveTimer = null;
    const speed = this.pendingSave;
    const newSite = this.pendingNewSite;
    this.pendingSave = null;
    this.pendingNewSite = false;
    if (speed === null || !this.alive()) return;
    try {
      await saveRememberedSpeed(speed, this.site, this.settings.rememberPerSite, newSite);
    } catch (error) {
      if (this.alive()) this.report(this.target(), `Couldn't remember this speed: ${errorMessage(error)}`);
    }
  }

  private readonly onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || this.destroyed) return;
    const settingsChange = changes[SETTINGS_KEY];
    if (settingsChange) {
      const previous = this.settings;
      this.settings = sanitizeSettings(settingsChange.newValue);
      if (previous.showController !== this.settings.showController) {
        this.controllersVisible = this.settings.showController;
        this.overlay.setControllersVisible(this.controllersVisible);
      }
      this.overlay.refreshLabels();
      this.updateActivation();
      if (this.active && previous.includeAudio !== this.settings.includeAudio) {
        if (this.settings.includeAudio) this.scanner.deepScan(true);
        else for (const media of this.tracked) if (media.kind === 'audio') this.untrack(media);
      }
    }
    const globalChange = changes[GLOBAL_SPEED_KEY];
    if (globalChange) this.remembered = { ...this.remembered, global: parseGlobalSpeed(globalChange.newValue) };
    const siteChange = this.site ? changes[siteSpeedKey(this.site)] : undefined;
    if (siteChange) this.remembered = { ...this.remembered, site: parseSiteSpeed(siteChange.newValue) };
    if (isAccessChange(changes)) {
      loadAccess()
        .then((access) => {
          if (!this.destroyed) this.access = access;
        })
        .catch(() => {
          // Keep the previous plan; the next change or page load reads it again.
        });
    }
  };

  // --- Popup messages ---------------------------------------------------------------------------

  private readonly onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id || !isContentRequest(message)) return false;
    if (message.type === 'vsp/discover') {
      if (this.active) this.scanner.deepScan(true);
      const status = this.status();
      if (this.isTop) {
        sendResponse(status);
      } else if (status.mediaCount > 0) {
        // Only one frame can answer a broadcast; sub-frames report separately so the popup learns their frameId.
        const report: FrameReport = { type: 'vsp/report', nonce: message.nonce, status };
        chrome.runtime.sendMessage(report).catch(() => {
          // The popup closed before the report arrived; nobody is waiting for it.
        });
      }
      return false;
    }
    sendResponse(this.command(message.command));
    return false;
  };

  private command(command: Command): CommandResponse {
    if (!this.active) return { ok: false, error: 'Video Speed+ is turned off on this site.' };
    const media = this.target();
    if (!media) return { ok: false, error: 'The video is no longer on the page. Reopen the popup to look again.' };
    const speed = command.kind === 'set' ? command.speed : stepSpeed(media.speed, command.direction * this.settings.step);
    const ok = this.setSpeed(media, speed, 'popup');
    if (!ok) return { ok: false, error: this.problem ?? 'The speed could not be changed.' };
    return { ok: true, status: this.status() };
  }

  private status(): FrameStatus {
    const target = this.active ? this.target() : null;
    let summary: MediaSummary | null = null;
    if (target) {
      summary = {
        kind: target.kind,
        speed: target.speed,
        paused: target.element.paused,
        ...target.snapshot(this.visibleArea(target)),
      };
    }
    const selector = this.settings.includeAudio ? 'video, audio' : 'video';
    return {
      top: this.isTop,
      site: this.site,
      frameHost: this.frameHost,
      blockedBy: this.blockedBy,
      mediaCount: this.active ? this.connectedMedia().length : document.querySelectorAll(selector).length,
      target: summary,
      problem: this.problem,
    };
  }
}

