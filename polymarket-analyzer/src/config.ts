/**
 * Runtime configuration. There is nothing for users to configure: the API origins are fixed
 * at build time (the e2e build points them at a local fixture server).
 */
export const API = {
  gammaBase: __GAMMA_BASE__,
  clobBase: __CLOB_BASE__,
} as const;

/** API responses are reused for this long before a new request is made. */
export const CACHE_TTL_MS = 60_000;

/** When a refresh fails, cached data up to this age is shown, marked stale. */
export const MAX_STALE_MS = 6 * 60 * 60 * 1000;

/** Search waits this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 300;
