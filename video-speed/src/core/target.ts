/**
 * Which media element a shortcut (or the popup) controls. Pure; the content script feeds it
 * a snapshot of every tracked element, and the popup feeds it one summary per frame.
 *
 * Rule, in order:
 *  1. The element the user interacted with most recently (clicked its area or its
 *     controller, or controlled it with a shortcut / the popup), as long as it is still
 *     visible or playing.
 *  2. Otherwise a playing element: the largest visible one, then the most recently started.
 *  3. Otherwise the largest visible element.
 *  4. Otherwise nothing (hidden, paused elements such as preloaded ads are never picked).
 */

export interface TargetCandidate {
  /** Last user interaction (ms since epoch), 0 = never. */
  interactedAt: number;
  /** Last time playback started (ms since epoch), 0 = never. */
  startedAt: number;
  /** Not paused and not ended. */
  playing: boolean;
  /** Area (px²) currently visible in its viewport. */
  visibleArea: number;
}

function eligible(candidate: TargetCandidate): boolean {
  return candidate.visibleArea > 0 || candidate.playing;
}

function best<T>(items: readonly T[], better: (a: T, b: T) => boolean): T | null {
  let result: T | null = null;
  for (const item of items) if (result === null || better(item, result)) result = item;
  return result;
}

export function pickTarget<T extends TargetCandidate>(candidates: readonly T[]): T | null {
  const interacted = candidates.filter((c) => c.interactedAt > 0 && eligible(c));
  if (interacted.length) return best(interacted, (a, b) => a.interactedAt > b.interactedAt);

  const playing = candidates.filter((c) => c.playing);
  if (playing.length) {
    return best(playing, (a, b) => a.visibleArea > b.visibleArea || (a.visibleArea === b.visibleArea && a.startedAt > b.startedAt));
  }

  const visible = candidates.filter((c) => c.visibleArea > 0);
  return best(visible, (a, b) => a.visibleArea > b.visibleArea);
}

/** Area of a rectangle that lies inside the viewport. */
export function visibleAreaOf(
  rect: { left: number; top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
): number {
  const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
  return width > 0 && height > 0 ? Math.round(width * height) : 0;
}
