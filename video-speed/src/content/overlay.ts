import arrowCounterclockwise from 'bootstrap-icons/icons/arrow-counterclockwise.svg';
import dashLg from 'bootstrap-icons/icons/dash-lg.svg';
import exclamationTriangle from 'bootstrap-icons/icons/exclamation-triangle.svg';
import eyeSlash from 'bootstrap-icons/icons/eye-slash.svg';
import plusLg from 'bootstrap-icons/icons/plus-lg.svg';
import { formatSpeed, sameSpeed } from '../core/speed';
import css from '../styles/overlay.scss';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import type { ManagedMedia } from './media';

/**
 * In-page UI: one small controller per video (top-left corner) and a short-lived indicator.
 *
 * Everything lives in one shadow root on a host element appended to <html>, so page CSS
 * can't reach it and it doesn't touch the site's own DOM. Controllers are positioned over
 * their video with fixed coordinates. When the site goes fullscreen, the host moves inside
 * the fullscreen element (the only subtree Chrome renders then) and moves back afterwards.
 *
 * The layer doesn't take pointer events; only a visible controller does, and events on it
 * don't propagate to the page (so e.g. click-to-pause players don't react to our buttons).
 */

export type ControllerAction = 'slower' | 'faster' | 'reset' | 'hide';

export interface OverlayCallbacks {
  action(media: ManagedMedia, action: ControllerAction): void;
  /** Tooltip for a button, e.g. "Faster (D)". */
  label(action: ControllerAction): string;
}

export type FlashTone = 'speed' | 'hint' | 'warning';

const HOST_TAG = 'video-speed-plus';
/** How long a controller stays visible after activity (hover, speed change). */
const ACTIVE_MS = 2200;
const FLASH_MS: Record<FlashTone, number> = { speed: 900, hint: 1800, warning: 5000 };
/** Videos smaller than this get no controller (thumbnails, avatars). */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 64;
const INSET = 8;

const BUTTONS: readonly [ControllerAction, string][] = [
  ['slower', dashLg],
  ['faster', plusLg],
  ['reset', arrowCounterclockwise],
  ['hide', eyeSlash],
];

/** Events that must not reach the page when they happen on a controller. */
const ISOLATED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'keydown',
  'keyup',
  'keypress',
] as const;

interface View {
  media: ManagedMedia;
  root: HTMLDivElement;
  speed: HTMLSpanElement;
  buttons: Map<ControllerAction, HTMLButtonElement>;
  activeUntil: number;
  hovered: boolean;
  placed: boolean;
}

/** The element that is really fullscreen, looking through (open or closed) shadow roots. */
function fullscreenElement(): Element | null {
  let element = document.fullscreenElement;
  for (let depth = 0; element && depth < 16; depth += 1) {
    const root = element.shadowRoot ?? safeShadowRoot(element);
    const inner = root?.fullscreenElement;
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

function safeShadowRoot(element: Element): ShadowRoot | null {
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** `ancestor.contains(node)`, but across shadow boundaries. */
function composedContains(ancestor: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
  }
  return false;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private layer: HTMLDivElement | null = null;
  private bezel: HTMLDivElement | null = null;
  private readonly views = new Map<ManagedMedia, View>();
  private controllersVisible = true;
  private frame: number | null = null;
  private stateTimer: number | null = null;
  private bezelTimer: number | null = null;
  private pointer: { x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private listening = false;

  constructor(private readonly callbacks: OverlayCallbacks) {}

  isOwnNode(node: Node): boolean {
    return node === this.host;
  }

  isOwnEvent(event: Event): boolean {
    return this.host !== null && event.composedPath().includes(this.host);
  }

  add(media: ManagedMedia): void {
    if (this.views.has(media) || media.kind !== 'video') return;
    const speed = h('span', { class: 'vsp-speed' });
    const buttons = new Map<ControllerAction, HTMLButtonElement>();
    for (const [action, svg] of BUTTONS) {
      const label = this.callbacks.label(action);
      const button = h(
        'button',
        { class: 'btn vsp-btn', attrs: { type: 'button', 'data-action': action, 'aria-label': label, title: label } },
        icon(svg, { size: 14 }),
      );
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.callbacks.action(media, action);
      });
      buttons.set(action, button);
    }
    const root = h(
      'div',
      { class: 'vsp-ctl', attrs: { role: 'group', 'aria-label': 'Video Speed+ controller', 'data-state': 'hidden' } },
      speed,
      h('div', { class: 'vsp-actions' }, ...buttons.values()),
    );
    for (const type of ISOLATED_EVENTS) root.addEventListener(type, (event) => event.stopPropagation());
    // Clicking a button shouldn't move focus off the page (Space would then press our button
    // instead of pausing the video). Keyboard users can still Tab to the buttons.
    root.addEventListener('mousedown', (event) => event.preventDefault());
    const view: View = { media, root, speed, buttons, activeUntil: 0, hovered: false, placed: false };
    root.addEventListener('pointerenter', () => {
      view.hovered = true;
      this.renderStates();
    });
    root.addEventListener('pointerleave', () => {
      view.hovered = false;
      view.activeUntil = Date.now() + ACTIVE_MS;
      this.renderStates();
    });
    this.views.set(media, view);
    this.ensureLayer().append(root);
    this.renderSpeed(view);
    this.listen();
    this.resizeObserver?.observe(media.element);
    this.scheduleLayout();
  }

  remove(media: ManagedMedia): void {
    const view = this.views.get(media);
    if (!view) return;
    view.root.remove();
    this.views.delete(media);
    this.resizeObserver?.unobserve(media.element);
    if (!this.views.size) this.unlisten();
  }

  /** Refreshes the speed shown; `activate` also reveals the controller for a moment. */
  update(media: ManagedMedia, activate = false): void {
    const view = this.views.get(media);
    if (!view) return;
    this.renderSpeed(view);
    if (activate) {
      view.activeUntil = Date.now() + ACTIVE_MS;
      this.renderStates();
    }
  }

  setControllersVisible(visible: boolean): void {
    this.controllersVisible = visible;
    if (this.views.size) this.layout();
  }

  refreshLabels(): void {
    for (const view of this.views.values()) {
      for (const [action, button] of view.buttons) {
        const label = this.callbacks.label(action);
        button.title = label;
        button.setAttribute('aria-label', label);
      }
    }
  }

  /** Brief indicator over the video (or at the top of the viewport when it isn't visible). */
  flash(media: ManagedMedia | null, text: string, tone: FlashTone = 'speed'): void {
    const layer = this.ensureLayer();
    this.placeHost();
    if (!this.bezel) {
      this.bezel = h('div', { class: 'vsp-bezel', attrs: { role: 'status', 'aria-live': 'polite' } });
      layer.append(this.bezel);
    }
    const bezel = this.bezel;
    bezel.replaceChildren(tone === 'warning' ? icon(exclamationTriangle, { size: 18 }) : '', h('span', { text }));
    bezel.className = `vsp-bezel ${tone}`;

    let x = window.innerWidth / 2;
    let y = 72;
    const rect = media?.element.isConnected ? media.element.getBoundingClientRect() : null;
    const fs = fullscreenElement();
    const renderable = media && (!fs || (fs !== media.element && composedContains(fs, media.element)));
    if (rect && renderable && rect.width > 0 && rect.height > 0) {
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (right > left && bottom > top) {
        x = (left + right) / 2;
        y = (top + bottom) / 2;
      }
    }
    bezel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    // Restart the fade-in for rapid repeats.
    bezel.classList.remove('show');
    void bezel.offsetWidth;
    bezel.classList.add('show');
    if (this.bezelTimer !== null) window.clearTimeout(this.bezelTimer);
    this.bezelTimer = window.setTimeout(() => bezel.classList.remove('show'), FLASH_MS[tone]);
  }

  destroy(): void {
    this.unlisten();
    if (this.bezelTimer !== null) window.clearTimeout(this.bezelTimer);
    if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
    this.host?.remove();
    this.host = null;
    this.layer = null;
    this.bezel = null;
    this.views.clear();
  }

  // --- Layout ---------------------------------------------------------------------------------

  scheduleLayout = (): void => {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.layout();
    });
  };

  /** Places every controller over its video. Also called from the content script's 1 s tick. */
  layout(): void {
    if (!this.host) return;
    this.placeHost();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const fs = fullscreenElement();
    const now = Date.now();
    for (const view of this.views.values()) {
      const element = view.media.element;
      let placed = false;
      if (this.controllersVisible && element.isConnected && (!fs || (fs !== element && composedContains(fs, element)))) {
        const rect = element.getBoundingClientRect();
        const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
        if (onScreen && rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT) {
          const x = Math.max(rect.left, 0) + INSET;
          const y = Math.min(Math.max(rect.top, 0), rect.bottom - 48) + INSET;
          view.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
          placed = true;
          const pointer = this.pointer;
          if (pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom) {
            view.activeUntil = now + ACTIVE_MS;
          }
        }
      }
      view.placed = placed;
    }
    this.pointer = null;
    this.renderStates();
  }

  private renderSpeed(view: View): void {
    const speed = view.media.speed;
    const text = formatSpeed(speed);
    if (view.speed.textContent !== text) view.speed.textContent = text;
    view.speed.classList.toggle('changed', !sameSpeed(speed, 1));
  }

  private renderStates(): void {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const view of this.views.values()) {
      const active = view.hovered || view.activeUntil > now;
      const state = !view.placed ? 'hidden' : active ? 'active' : 'idle';
      if (view.root.getAttribute('data-state') !== state) view.root.setAttribute('data-state', state);
      if (view.placed && !view.hovered && view.activeUntil > now) next = Math.min(next, view.activeUntil);
    }
    if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
    this.stateTimer = Number.isFinite(next) ? window.setTimeout(() => this.renderStates(), next - now + 30) : null;
  }

  // --- Host -----------------------------------------------------------------------------------

  private ensureLayer(): HTMLDivElement {
    if (this.host && this.layer) return this.layer;
    const host = document.createElement(HOST_TAG);
    host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important; pointer-events: none !important; overflow: visible !important;';
    const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', { text: css }));
    }
    // Dark-first: the controller sits on top of video, whatever the OS theme is.
    const layer = h('div', { class: 'vsp-layer', attrs: { 'data-bs-theme': 'dark' } });
    root.append(layer);
    this.host = host;
    this.layer = layer;
    this.placeHost();
    return layer;
  }

  /** Keeps the host attached: inside the fullscreen element while there is one, else on <html>. */
  private placeHost(): void {
    const host = this.host;
    if (!host) return;
    const fs = fullscreenElement();
    const container = fs && !(fs instanceof HTMLMediaElement) ? fs : document.documentElement;
    if (container && host.parentNode !== container) container.append(host);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.scheduleLayout();
  };

  private readonly onFullscreenChange = (): void => {
    this.placeHost();
    this.layout();
  };

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.resizeObserver = new ResizeObserver(this.scheduleLayout);
    for (const media of this.views.keys()) this.resizeObserver.observe(media.element);
    window.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
    window.addEventListener('resize', this.scheduleLayout, { passive: true });
    document.addEventListener('scroll', this.scheduleLayout, { capture: true, passive: true });
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    window.removeEventListener('resize', this.scheduleLayout);
    document.removeEventListener('scroll', this.scheduleLayout, { capture: true });
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
