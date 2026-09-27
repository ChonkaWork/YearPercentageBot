import { describe, expect, it } from 'vitest';
import { pickTarget, visibleAreaOf, type TargetCandidate } from '../src/core/target';

type Named = TargetCandidate & { name: string };
const media = (name: string, extra: Partial<TargetCandidate> = {}): Named => ({
  name,
  interactedAt: 0,
  startedAt: 0,
  playing: false,
  visibleArea: 0,
  ...extra,
});

describe('pickTarget', () => {
  it('1. the most recently interacted element wins while it is visible or playing', () => {
    const clicked = media('clicked', { interactedAt: 50, visibleArea: 100 });
    const playing = media('playing', { playing: true, visibleArea: 5000, startedAt: 90 });
    expect(pickTarget([playing, clicked])?.name).toBe('clicked');
    const newer = media('newer', { interactedAt: 60, playing: true });
    expect(pickTarget([clicked, newer])?.name).toBe('newer');
  });

  it('1. an interacted element that is now hidden and paused no longer counts', () => {
    const gone = media('gone', { interactedAt: 99, visibleArea: 0, playing: false });
    const playing = media('playing', { playing: true, visibleArea: 10 });
    expect(pickTarget([gone, playing])?.name).toBe('playing');
  });

  it('2. otherwise a playing element: largest visible, then most recently started', () => {
    const bigPaused = media('big-paused', { visibleArea: 9000 });
    const smallPlaying = media('small-playing', { playing: true, visibleArea: 100 });
    expect(pickTarget([bigPaused, smallPlaying])?.name).toBe('small-playing');
    const bigPlaying = media('big-playing', { playing: true, visibleArea: 4000, startedAt: 1 });
    expect(pickTarget([smallPlaying, bigPlaying])?.name).toBe('big-playing');
    const audioA = media('audio-a', { playing: true, startedAt: 10 });
    const audioB = media('audio-b', { playing: true, startedAt: 20 });
    expect(pickTarget([audioA, audioB])?.name).toBe('audio-b');
  });

  it('3. otherwise the largest visible element', () => {
    expect(pickTarget([media('a', { visibleArea: 10 }), media('b', { visibleArea: 30 }), media('c', { visibleArea: 20 })])?.name).toBe('b');
  });

  it('4. hidden paused elements (preloaded ads) are never picked', () => {
    expect(pickTarget([media('hidden'), media('hidden-2')])).toBeNull();
    expect(pickTarget([])).toBeNull();
  });
});

describe('visibleAreaOf', () => {
  const viewport = { width: 1000, height: 800 };
  it('counts only the part inside the viewport', () => {
    expect(visibleAreaOf({ left: 0, top: 0, right: 640, bottom: 360 }, viewport)).toBe(230400);
    expect(visibleAreaOf({ left: -100, top: -100, right: 100, bottom: 100 }, viewport)).toBe(10000);
    expect(visibleAreaOf({ left: 900, top: 700, right: 1100, bottom: 900 }, viewport)).toBe(10000);
    expect(visibleAreaOf({ left: 0, top: 900, right: 640, bottom: 1260 }, viewport)).toBe(0);
    expect(visibleAreaOf({ left: 0, top: 0, right: 0, bottom: 0 }, viewport)).toBe(0);
  });
});
