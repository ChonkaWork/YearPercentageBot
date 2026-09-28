import { describe, expect, it } from 'vitest';
import { routeOf, shortsVideoId, watchVideoId } from '../src/core/routes';

describe('routeOf', () => {
  it.each([
    ['/', 'home'],
    ['', 'home'],
    ['/index', 'home'],
    ['/watch', 'watch'],
    ['/shorts/abcDEF12345', 'shorts'],
    ['/shorts', 'shorts'],
    ['/feed/subscriptions', 'subscriptions'],
    ['/feed/subscriptions/', 'subscriptions'],
    ['/results', 'search'],
    ['/feed/trending', 'explore'],
    ['/feed/explore', 'explore'],
    ['/gaming', 'explore'],
    ['/@calmcoding', 'channel'],
    ['/@calmcoding/videos', 'channel'],
    ['/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', 'channel'],
    ['/c/Legacy', 'channel'],
    ['/feed/history', 'other'],
    ['/playlist', 'other'],
    ['/shortsfan', 'other'],
    ['/feed/trendingnow', 'other'],
  ])('%s → %s', (path, route) => {
    expect(routeOf(path)).toBe(route);
  });
});

describe('video ids', () => {
  it('reads a Shorts id', () => {
    expect(shortsVideoId('/shorts/abcDEF12345')).toBe('abcDEF12345');
    expect(shortsVideoId('/shorts/abcDEF12345/')).toBe('abcDEF12345');
    expect(shortsVideoId('/shorts/')).toBeNull();
    expect(shortsVideoId('/shorts/a b')).toBeNull();
    expect(shortsVideoId('/shorts/x/y')).toBeNull();
  });

  it('reads a watch id', () => {
    expect(watchVideoId('?v=abcDEF12345&t=10')).toBe('abcDEF12345');
    expect(watchVideoId('?list=x')).toBeNull();
    expect(watchVideoId('?v=<script>')).toBeNull();
  });
});
