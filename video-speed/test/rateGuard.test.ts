import { describe, expect, it } from 'vitest';
import { classifyRateChange, FRESH_GUARD, RATE_GUARD, tryReassert, type GuardState } from '../src/core/rateGuard';

const base = { now: 10_000, actual: 1, desired: 2 as number | null, lastGestureAt: 0, lastLifecycleAt: 0 };

describe('classifyRateChange', () => {
  it('in sync when the element is at the desired speed (our own change)', () => {
    expect(classifyRateChange({ ...base, actual: 2 })).toBe('in-sync');
  });

  it('site reset right after a lifecycle event → put ours back', () => {
    expect(classifyRateChange({ ...base, lastLifecycleAt: 9_500 })).toBe('site');
  });

  it('the user clicked play and the site reset on play → still the site', () => {
    expect(classifyRateChange({ ...base, lastGestureAt: 9_990, lastLifecycleAt: 9_995 })).toBe('site');
  });

  it("right after a click/key on the page, with no lifecycle event → the user's choice", () => {
    expect(classifyRateChange({ ...base, lastGestureAt: 9_700 })).toBe('user');
    expect(classifyRateChange({ ...base, desired: null, lastGestureAt: 9_700 })).toBe('user');
  });

  it('a script changing it with no gesture → the site', () => {
    expect(classifyRateChange({ ...base, lastGestureAt: 1_000, lastLifecycleAt: 1_000 })).toBe('site');
  });

  it('elements we do not manage are left alone', () => {
    expect(classifyRateChange({ ...base, desired: null })).toBe('unmanaged');
    expect(classifyRateChange({ ...base, desired: null, lastGestureAt: 9_990, lastLifecycleAt: 9_990 })).toBe('unmanaged');
  });

  it('uses the configured windows', () => {
    expect(classifyRateChange({ ...base, lastGestureAt: base.now - RATE_GUARD.gestureMs })).toBe('user');
    expect(classifyRateChange({ ...base, lastGestureAt: base.now - RATE_GUARD.gestureMs - 1 })).toBe('site');
  });
});

describe('tryReassert', () => {
  it(`allows ${RATE_GUARD.maxReasserts} corrections per window, then gives up once`, () => {
    let state: GuardState = FRESH_GUARD;
    const outcomes: string[] = [];
    for (let i = 0; i < RATE_GUARD.maxReasserts + 3; i += 1) {
      const result = tryReassert(state, 1_000 + i * 10);
      state = result.state;
      outcomes.push(result.allowed ? 'set' : result.justGaveUp ? 'gave-up' : 'quiet');
    }
    expect(outcomes).toEqual([...Array(RATE_GUARD.maxReasserts).fill('set'), 'gave-up', 'quiet', 'quiet']);
    expect(state.gaveUp).toBe(true);
  });

  it('corrections spread out over time never run out', () => {
    let state: GuardState = FRESH_GUARD;
    for (let i = 0; i < 50; i += 1) {
      const result = tryReassert(state, i * RATE_GUARD.windowMs);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    expect(state.reasserts.length).toBeLessThanOrEqual(RATE_GUARD.maxReasserts);
  });

  it('terminates a simulated fight with a page that undoes every change', () => {
    // Our set → the page's ratechange handler resets to 1 → we classify and maybe set again ...
    let state: GuardState = FRESH_GUARD;
    let actual = 1;
    let events = 0;
    const queue: number[] = [2]; // the user asked for 2×
    let now = 5_000;
    while (queue.length && events < 1000) {
      actual = queue.shift()!;
      events += 1; // ratechange for our set
      actual = 1; // page resets immediately
      events += 1; // ratechange for their reset
      now += 5;
      if (classifyRateChange({ now, actual, desired: 2, lastGestureAt: 0, lastLifecycleAt: 0 }) === 'site') {
        const result = tryReassert(state, now);
        state = result.state;
        if (result.allowed) queue.push(2);
      }
    }
    expect(events).toBe(2 * (RATE_GUARD.maxReasserts + 1));
    expect(state.gaveUp).toBe(true);
  });
});
