import { MS_PER_SECOND, floorToSecond } from '../core/time';

/**
 * Calls `onTick` right away and then at the start of every second, with `now` rounded down to the
 * second. Stops while the tab is hidden (nothing to show, no wasted work) and catches up
 * immediately when it becomes visible again.
 */
export function startTicker(onTick: (now: Date) => void): { tickNow(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const run = () => {
    stop();
    if (document.hidden) return;
    onTick(floorToSecond(Date.now()));
    // A few ms past the boundary so the new second has surely started.
    timer = setTimeout(run, MS_PER_SECOND - (Date.now() % MS_PER_SECOND) + 5);
  };

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()));
  run();
  return { tickNow: run };
}
