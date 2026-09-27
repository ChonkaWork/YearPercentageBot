import type { CheckError, ErrorCode } from './types';

/**
 * User-facing error texts. Each one says what happened and what to do.
 */

export const JS_RENDERED_MESSAGE =
  "This page renders with JavaScript. Page Watch checks pages without running their scripts, so it would only see an empty page. Watching pages like this isn't supported yet.";

const MESSAGES: Record<Exclude<ErrorCode, 'http'>, string> = {
  offline: "You're offline. Page Watch will check again when it's time for the next try.",
  network: "Couldn't reach the site. It may be down or blocking the request. Page Watch will try again later.",
  timeout: 'The site took too long to answer. Page Watch will try again later.',
  'not-html': "This address doesn't return a web page, so there's no text to watch.",
  'too-large': 'The page is larger than 5 MB, which is more than Page Watch reads.',
  permission: 'Page Watch no longer has access to this site. Grant access again to keep watching it.',
  selector:
    "The part of the page you picked isn't there anymore. The site may have changed its layout. Delete this watch and pick the element again.",
  'js-rendered': JS_RENDERED_MESSAGE,
  empty:
    'The page came back (almost) empty. The site may now load its content with JavaScript or block automated requests.',
  internal: 'Something went wrong while checking. Page Watch will try again later.',
};

export function httpErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `The site refused access (HTTP ${status}). If the page needs you to sign in, sign in in this browser and check again.`;
  }
  if (status === 404 || status === 410) return `Page not found (HTTP ${status}). It may have moved or been removed.`;
  if (status === 429) return 'The site asked Page Watch to slow down (HTTP 429). It will try again later.';
  if (status >= 500) return `The site had a server error (HTTP ${status}). Page Watch will try again later.`;
  return `The site answered with HTTP ${status} instead of the page.`;
}

export function checkError(code: ErrorCode, extra: { status?: number; retryAfterSeconds?: number; detail?: string } = {}): CheckError {
  const message = code === 'http' ? httpErrorMessage(extra.status ?? 0) : MESSAGES[code];
  const error: CheckError = { code, message: extra.detail ? `${message} ${extra.detail}` : message };
  if (extra.status !== undefined) error.status = extra.status;
  if (extra.retryAfterSeconds !== undefined) error.retryAfterSeconds = extra.retryAfterSeconds;
  return error;
}

/** Errors that usually fix themselves; they're retried with backoff and only notified if they persist. */
export function isTransient(error: Pick<CheckError, 'code' | 'status'>): boolean {
  switch (error.code) {
    case 'offline':
    case 'network':
    case 'timeout':
    case 'internal':
      return true;
    case 'http':
      return error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
    default:
      return false;
  }
}

/** Short label for the list row. */
export function errorLabel(error: Pick<CheckError, 'code' | 'status'>): string {
  switch (error.code) {
    case 'offline':
      return 'Offline';
    case 'network':
      return "Couldn't reach the site";
    case 'timeout':
      return 'Timed out';
    case 'http':
      return `HTTP ${error.status ?? 'error'}`;
    case 'not-html':
      return 'Not a web page';
    case 'too-large':
      return 'Page too large';
    case 'permission':
      return 'Needs site access';
    case 'selector':
      return 'Element not found';
    case 'js-rendered':
      return 'Needs JavaScript';
    case 'empty':
      return 'Page came back empty';
    default:
      return 'Check failed';
  }
}

/** Parses a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - now) / 1000));
}
