/**
 * Channel allowlist (Pro). Pure: parsing what the user types or what a channel link points to,
 * and matching the current video's channel against the list.
 *
 * A channel is known by its handle (`@name`, case-insensitive) and/or its id (`UC` + 22
 * characters). Legacy `/c/Name` and `/user/Name` URLs can't be mapped to either offline, so
 * they aren't accepted.
 */

export interface ChannelRef {
  /** `UC…` channel id, when known. */
  id: string | null;
  /** Lower-cased handle with its `@`, when known. */
  handle: string | null;
}

export interface AllowedChannel extends ChannelRef {
  /** What the user sees in the list: the channel name, or the handle/id they typed. */
  name: string;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
// YouTube handles: 3–30 letters, digits, '_', '-', '.', '·' (non-Latin letters allowed).
const HANDLE = /^@[\p{L}\p{M}\p{N}._·-]{3,30}$/u;
const MAX_NAME = 100;

export function normalizeHandle(value: string): string | null {
  let text = value.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the raw text; the pattern decides.
  }
  if (!text.startsWith('@')) text = `@${text}`;
  return HANDLE.test(text) ? text.toLowerCase() : null;
}

export function isChannelId(value: string): boolean {
  return CHANNEL_ID.test(value);
}

/**
 * A channel from a link path or URL: `/@name`, `/@name/videos`, `/channel/UC…`, or the same on
 * www./m.youtube.com. Anything else is null.
 */
export function channelFromHref(href: string): ChannelRef | null {
  let path = href.trim();
  const url = /^(?:https?:)?\/\/([^/]+)(\/[^?#]*)?/i.exec(path);
  if (url) {
    const host = (url[1] ?? '').toLowerCase();
    if (!/^(?:www\.|m\.)?youtube\.com$/.test(host)) return null;
    path = url[2] ?? '/';
  }
  path = path.replace(/[?#].*$/, '');
  const handle = /^\/(@[^/]+)/.exec(path);
  if (handle) {
    const normalized = normalizeHandle(handle[1] ?? '');
    return normalized ? { id: null, handle: normalized } : null;
  }
  const id = /^\/channel\/([^/]+)/.exec(path);
  if (id && isChannelId(id[1] ?? '')) return { id: id[1] ?? null, handle: null };
  return null;
}

/**
 * What the user typed in the allowlist box: `@name`, `name`, `UC…`, or a channel URL (with or
 * without https://). Null when it isn't recognisable.
 */
export function parseChannelInput(input: string): ChannelRef | null {
  const text = input.trim();
  if (!text) return null;
  if (isChannelId(text)) return { id: text, handle: null };
  if (/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\//i.test(text)) {
    return channelFromHref(/^https?:/i.test(text) ? text : `https://${text}`);
  }
  if (text.includes('/') || /\s/.test(text)) return null;
  const handle = normalizeHandle(text);
  return handle ? { id: null, handle } : null;
}

/** Same channel when the ids match or the handles match. */
export function sameChannel(a: ChannelRef, b: ChannelRef): boolean {
  return (a.id !== null && a.id === b.id) || (a.handle !== null && a.handle === b.handle);
}

export function findChannel(list: readonly AllowedChannel[], channel: ChannelRef | null): AllowedChannel | null {
  if (!channel) return null;
  return list.find((entry) => sameChannel(entry, channel)) ?? null;
}

export function isAllowed(list: readonly AllowedChannel[], channel: ChannelRef | null, max = Number.POSITIVE_INFINITY): boolean {
  return findChannel(list.slice(0, max), channel) !== null;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

function displayName(channel: ChannelRef, name: unknown): string {
  return cleanName(name) || channel.handle || channel.id || '';
}

/**
 * Adds a channel, or completes an existing entry for it (a missing id or handle, a better name).
 * Returns the same array when nothing changed.
 */
export function addChannel(list: readonly AllowedChannel[], channel: ChannelRef, name = '', max = Number.POSITIVE_INFINITY): AllowedChannel[] {
  const index = list.findIndex((entry) => sameChannel(entry, channel));
  if (index === -1) {
    if (list.length >= max) return [...list];
    return [...list, { id: channel.id, handle: channel.handle, name: displayName(channel, name) }];
  }
  const existing = list[index]!;
  const merged: AllowedChannel = {
    id: existing.id ?? channel.id,
    handle: existing.handle ?? channel.handle,
    name: cleanName(name) || existing.name,
  };
  if (merged.id === existing.id && merged.handle === existing.handle && merged.name === existing.name) return [...list];
  const next = [...list];
  next[index] = merged;
  return next;
}

export function removeChannel(list: readonly AllowedChannel[], channel: ChannelRef): AllowedChannel[] {
  return list.filter((entry) => !sameChannel(entry, channel));
}

/** Anything read from storage becomes a valid, de-duplicated list of at most `max` entries. */
export function sanitizeAllowlist(raw: unknown, max: number): AllowedChannel[] {
  if (!Array.isArray(raw)) return [];
  let list: AllowedChannel[] = [];
  for (const item of raw) {
    if (list.length >= max) break;
    if (typeof item !== 'object' || item === null) continue;
    const input = item as Record<string, unknown>;
    const id = typeof input.id === 'string' && isChannelId(input.id) ? input.id : null;
    const handle = typeof input.handle === 'string' ? normalizeHandle(input.handle) : null;
    if (!id && !handle) continue;
    list = addChannel(list, { id, handle }, cleanName(input.name));
  }
  return list;
}

/** "@name" or the id, for secondary text next to the name. */
export function channelLabel(channel: ChannelRef): string {
  return channel.handle ?? channel.id ?? '';
}
