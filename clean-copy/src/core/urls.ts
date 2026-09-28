/**
 * Removes tracking parameters from web addresses found anywhere in copied text.
 *
 * Only the query string is touched, and only by dropping whole `name=value` pairs: the rest
 * of the address (scheme, host, path, encoding, fragment) stays byte for byte, so a link
 * never changes meaning. Pure: no DOM, no Chrome APIs.
 */

import type { Edit, StepResult } from './changes';

/** Marketing and click-tracking parameters, on every site. */
const TRACKING_PARAM =
  /^(?:utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|mc_cid|mc_eid|igshid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|ref_src|ref_url|oly_anon_id|oly_enc_id|vero_id|vero_conv|__s|s_cid|trk|trkinfo|trackingid|_ga|_gl|srsltid|rb_clickid|wickedid|irclickid|epik|sc_cid|cmpid|ncid|spm)$/i;

/** Parameters that are tracking only on some sites (elsewhere the same name can matter). */
const SITE_PARAMS: readonly { host: RegExp; param: RegExp }[] = [
  // Share identifiers.
  { host: /(?:^|\.)(?:youtube\.com|youtu\.be|spotify\.com)$/i, param: /^(?:si|feature|pp)$/i },
  { host: /(?:^|\.)instagram\.com$/i, param: /^(?:igsh|img_index)$/i },
  { host: /(?:^|\.)(?:twitter\.com|x\.com)$/i, param: /^(?:s|t|ref_src|ref_url)$/i },
  { host: /(?:^|\.)linkedin\.com$/i, param: /^(?:trk|trackingid|lipi|refid|midtoken|midsig|eid|otptoken)$/i },
  { host: /(?:^|\.)tiktok\.com$/i, param: /^(?:_r|_t|is_from_webapp|sender_device|is_copy_url)$/i },
  { host: /(?:^|\.)reddit\.com$/i, param: /^(?:share_id|utm_name|ref|ref_source|rdt)$/i },
  // Amazon's ref tags and page-flow parameters.
  { host: /(?:^|\.)amazon\.[a-z.]+$/i, param: /^(?:ref|ref_|pd_rd_[a-z]+|pf_rd_[a-z]+|_encoding|content-id|sprefix|crid|dib|dib_tag|qid|sr)$/i },
];

/** A web address in running text. Trailing punctuation is trimmed separately. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`{}|\\^  -​　]+/gi;

export interface StripResult {
  text: string;
  /** Number of parameters removed across all addresses. */
  removed: number;
}

/** True when `name` (already decoded) is a tracking parameter for `host`. */
export function isTrackingParam(name: string, host = ''): boolean {
  if (TRACKING_PARAM.test(name)) return true;
  return SITE_PARAMS.some((rule) => rule.host.test(host) && rule.param.test(name));
}

/** Cleans one address. Returns it unchanged when it isn't an http(s) URL. */
export function stripTrackingFromUrl(url: string): { url: string; removed: number } {
  const { url: cleaned, removed } = analyzeUrl(url);
  return { url: cleaned, removed };
}

interface UrlAnalysis {
  url: string;
  removed: number;
  /** Removed ranges of the input address: whole parameters, their separators, a bare "?". */
  ranges: [number, number][];
}

function analyzeUrl(url: string): UrlAnalysis {
  const match = /^(https?:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!match) return { url, removed: 0, ranges: [] };
  const [, scheme = '', authority = '', path = '', query, fragment = ''] = match;
  if (!query) return { url, removed: 0, ranges: [] };
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  const queryStart = scheme.length + authority.length + path.length;
  let position = queryStart + 1;
  const pairs = query
    .slice(1)
    .split('&')
    .map((pair) => {
      const start = position;
      position += pair.length + 1;
      return { pair, start, keep: pair !== '' && !isTrackingParam(decodeName(pair), host), tracking: pair !== '' && isTrackingParam(decodeName(pair), host) };
    });
  const removed = pairs.filter((item) => item.tracking).length;
  if (removed === 0) return { url, removed: 0, ranges: [] };
  const kept = pairs.filter((item) => item.keep);
  const cleaned = `${scheme}${authority}${path}${kept.length ? `?${kept.map((item) => item.pair).join('&')}` : ''}${fragment}`;

  // Kept: "?" (when a parameter is left), the kept pairs, and the "&" right before every kept
  // pair but the first. Everything else in the query goes.
  const dropped = new Uint8Array(url.length);
  if (kept.length === 0) {
    dropped.fill(1, queryStart, queryStart + query.length);
  } else {
    const first = pairs.indexOf(kept[0] as (typeof pairs)[number]);
    pairs.forEach((item, index) => {
      if (!item.keep) dropped.fill(1, item.start, item.start + item.pair.length);
      const separator = item.start + item.pair.length;
      const nextKept = pairs[index + 1]?.keep === true && index + 1 > first;
      if (index < pairs.length - 1 && !nextKept) dropped[separator] = 1;
    });
  }
  const ranges: [number, number][] = [];
  for (let i = 0; i < dropped.length; i++) {
    if (!dropped[i]) continue;
    const start = i;
    while (i < dropped.length && dropped[i]) i++;
    ranges.push([start, i]);
  }
  return { url: cleaned, removed, ranges };
}

function decodeName(pair: string): string {
  const rawName = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    // Malformed escape: compare the raw name.
    return rawName;
  }
}

/**
 * Splits trailing characters that belong to the sentence, not the address: punctuation,
 * and closing brackets without an opening one inside the address (Wikipedia-style
 * "Kyiv_(city)" keeps its parenthesis).
 */
export function trimUrlEnd(candidate: string): { url: string; rest: string } {
  let url = candidate;
  let rest = '';
  for (;;) {
    const last = url.slice(-1);
    if (/[.,;:!?…'"»”’*]/.test(last)) {
      rest = last + rest;
      url = url.slice(0, -1);
      continue;
    }
    const pair = { ')': '(', ']': '[' }[last];
    if (pair) {
      const opens = url.split(pair).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        rest = last + rest;
        url = url.slice(0, -1);
        continue;
      }
    }
    return { url, rest };
  }
}

/** Removes tracking parameters from every http(s) address in `text`. */
export function stripTrackingParams(text: string): StripResult {
  const { text: cleaned, removed } = stripTrackingStep(text);
  return { text: cleaned, removed };
}

/** stripTrackingParams as a pipeline step: also reports the removed ranges as edits. */
export function stripTrackingStep(text: string): StepResult & { removed: number } {
  let removed = 0;
  const edits: Edit[] = [];
  const cleaned = text.replace(URL_IN_TEXT, (candidate: string, offset: number) => {
    const { url, rest } = trimUrlEnd(candidate);
    const result = analyzeUrl(url);
    removed += result.removed;
    for (const [start, end] of result.ranges) edits.push({ start: offset + start, end: offset + end, kind: 'tracking' });
    return result.url + rest;
  });
  return { text: cleaned, removed, edits };
}
