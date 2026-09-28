import { SITE_NAMES, type Role, type SiteId } from '../core/types';

/** Small shared pieces of every format: role labels and dates. */

export function roleLabel(role: Role, site: SiteId): string {
  return role === 'user' ? 'You' : SITE_NAMES[site];
}

/** "2026-09-27 14:03" in local time. */
export function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-09-27" in local time. */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "2026-09-27T14:03" in local time: a date-time property in Obsidian's front matter. */
export function formatLocalIso(date: Date): string {
  return formatDateTime(date).replace(' ', 'T');
}

/** "chatgpt.com" from a conversation URL ('' when there is none). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
