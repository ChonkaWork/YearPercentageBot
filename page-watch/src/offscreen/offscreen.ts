import type { CandidateResult, ExtractedText } from '../core/creation';
import { extractText } from '../core/extract';
import { capSnapshot, collapseSpaces } from '../core/normalize';
import { isExtractRequest, type ExtractRequest, type ExtractResponse } from '../platform/messages';

/**
 * Offscreen document: parses fetched HTML with DOMParser (scripts never run, nothing is
 * loaded) and returns plain text for the whole page or for each candidate selector.
 */

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtractRequest(message)) return false;
  let response: ExtractResponse;
  try {
    response = extract(message);
  } catch (error) {
    response = { ok: false, message: error instanceof Error ? error.message : 'Could not parse the page.' };
  }
  sendResponse(response);
  return false;
});

function textOf(node: Node): ExtractedText {
  return capSnapshot(extractText(node));
}

function extract(request: ExtractRequest): ExtractResponse {
  const doc = new DOMParser().parseFromString(request.html, 'text/html');
  const title = collapseSpaces(doc.title).slice(0, 200);
  if (request.selectors === null) {
    return { ok: true, title, page: textOf(doc.body ?? doc.documentElement), results: [] };
  }
  const results = request.selectors.map((selector): CandidateResult => {
    let matches: NodeListOf<Element>;
    try {
      matches = doc.querySelectorAll(selector);
    } catch {
      return { selector, matchCount: 0, text: null, truncated: false };
    }
    const first = matches[0];
    if (!first) return { selector, matchCount: 0, text: null, truncated: false };
    const { text, truncated } = textOf(first);
    return { selector, matchCount: matches.length, text, truncated };
  });
  return { ok: true, title, page: null, results };
}
