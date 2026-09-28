import { createShadowHost } from './shadow';

/**
 * Outlines a table on the page: while the popup's pointer or focus is on its card, and
 * while its rows are being recorded. A fixed box follows the table's position; it never
 * takes pointer events, so the page works as usual underneath.
 */

export const OUTLINE_TAG = 'table-copy-outline';

export type OutlineKind = 'hover' | 'recording';

export interface Outline {
  /** Place it again now (something else moved). */
  move(): void;
  /** Follow the table again (it may have been replaced by a new element). */
  retarget(element: Element): void;
  remove(): void;
}

/** `onMove` is told where the table is after every placement (null while it's gone). */
export function outline(target: Element, kind: OutlineKind, onMove?: (rect: DOMRect | null) => void): Outline {
  removeOutlines(kind);
  const { host, root } = createShadowHost(OUTLINE_TAG, 2147483646);
  host.dataset.kind = kind;
  const box = document.createElement('div');
  box.className = `tc-outline tc-outline-${kind}`;
  root.append(box);
  document.documentElement.append(host);

  let element = target;
  let frame = 0;
  const place = () => {
    frame = 0;
    if (!host.isConnected) return stop();
    const rect = element.getBoundingClientRect();
    const hidden = !element.isConnected || (rect.width === 0 && rect.height === 0);
    box.hidden = hidden;
    onMove?.(hidden ? null : rect);
    if (hidden) return;
    box.style.transform = `translate(${Math.round(rect.left) - 4}px, ${Math.round(rect.top) - 4}px)`;
    box.style.width = `${Math.round(rect.width) + 8}px`;
    box.style.height = `${Math.round(rect.height) + 8}px`;
  };
  const schedule = () => {
    frame ||= window.requestAnimationFrame(place);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  // Layout can also move the table without a scroll or resize (content loading above it).
  const timer = window.setInterval(schedule, 500);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const stop = () => {
    resize.disconnect();
    window.clearInterval(timer);
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    if (frame) window.cancelAnimationFrame(frame);
  };
  place();

  return {
    move: schedule,
    retarget(next) {
      resize.unobserve(element);
      element = next;
      resize.observe(element);
      schedule();
    },
    remove() {
      stop();
      host.remove();
    },
  };
}

/** Removes outlines, also those left by an earlier injection of the script. */
export function removeOutlines(kind?: OutlineKind): void {
  for (const host of Array.from(document.querySelectorAll<HTMLElement>(OUTLINE_TAG))) {
    if (!kind || host.dataset.kind === kind) host.remove();
  }
}

/** Brings a table into view unless enough of it is already visible (half the screen, or all of it). */
export function scrollToTable(element: Element): void {
  const rect = element.getBoundingClientRect();
  const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  if (visible >= Math.min(rect.height, window.innerHeight / 2) - 1) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: rect.height < window.innerHeight * 0.8 ? 'center' : 'start', behavior: smooth ? 'smooth' : 'auto' });
}
