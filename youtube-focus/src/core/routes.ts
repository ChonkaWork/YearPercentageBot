/** Which kind of YouTube page a path is. Pure; the same paths on www. and m.youtube.com. */

export type Route = 'home' | 'watch' | 'shorts' | 'subscriptions' | 'search' | 'explore' | 'channel' | 'other';

/** Recommendation-only pages that subscriptions-only mode sends to Subscriptions. */
const EXPLORE_PATHS = ['/feed/trending', '/feed/explore', '/feed/what_to_watch', '/feed/news_destination', '/gaming'];

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/index') return 'home';
  if (path === '/watch') return 'watch';
  if (under(path, '/shorts')) return 'shorts';
  if (path === '/feed/subscriptions') return 'subscriptions';
  if (path === '/results') return 'search';
  if (EXPLORE_PATHS.some((prefix) => under(path, prefix))) return 'explore';
  if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path)) return 'channel';
  return 'other';
}

/** Video id of a /shorts/<id> page, when it looks like one. */
export function shortsVideoId(pathname: string): string | null {
  const match = /^\/shorts\/([A-Za-z0-9_-]{6,20})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

/** The `v` parameter of a watch page URL's search string. */
export function watchVideoId(search: string): string | null {
  const id = new URLSearchParams(search).get('v');
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}
