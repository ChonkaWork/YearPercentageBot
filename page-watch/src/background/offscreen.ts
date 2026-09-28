import type { ChimeRequest, ChimeResponse, ExtractRequest, ExtractResponse } from '../platform/messages';

/**
 * The service worker has no DOM, so fetched HTML is parsed in an offscreen document
 * (reason DOM_PARSER) with DOMParser, which never runs the page's scripts or loads its
 * resources. The same document plays the optional alert chime (reason AUDIO_PLAYBACK): Chrome
 * allows one offscreen document per extension, so it's created with both reasons. It's opened
 * on demand and closed when no check is running.
 */

const OFFSCREEN_PATH = 'offscreen.html';

// Open and close calls run one after the other so they can't race.
let lifecycle: Promise<unknown> = Promise.resolve();
function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(task, task);
  lifecycle = run.catch(() => undefined);
  return run;
}

async function hasDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

function ensureDocument(): Promise<void> {
  return inOrder(async () => {
    if (await hasDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_PARSER' as chrome.offscreen.Reason, 'AUDIO_PLAYBACK' as chrome.offscreen.Reason],
        justification: 'Parse the HTML of watched pages to extract their text, and play the optional alert sound.',
      });
    } catch (error) {
      // Another context created it in the meantime.
      if (!(error instanceof Error && /single offscreen/i.test(error.message))) throw error;
    }
  });
}

export function closeOffscreen(): Promise<void> {
  return inOrder(async () => {
    try {
      if (await hasDocument()) await chrome.offscreen.closeDocument();
    } catch {
      // Already closed.
    }
  });
}

/** Extractions in flight: the chime doesn't close the document under them. */
let extracting = 0;

export async function extractInOffscreen(html: string, selectors: string[] | null): Promise<ExtractResponse> {
  extracting++;
  try {
    await ensureDocument();
    const request: ExtractRequest = { target: 'offscreen', type: 'pw/extract', html, selectors };
    const response = (await chrome.runtime.sendMessage(request)) as ExtractResponse | undefined;
    if (!response) return { ok: false, message: 'The page parser did not answer.' };
    return response;
  } finally {
    extracting--;
  }
}

/** Plays the chime and resolves once it has finished (so the document isn't closed mid-sound). */
export async function chimeInOffscreen(): Promise<ChimeResponse> {
  // During a check the document is already open and closes when checks are done; otherwise
  // (the quiet-hours summary) the chime closes what it opened.
  const opened = !(await hasDocument());
  await ensureDocument();
  const request: ChimeRequest = { target: 'offscreen', type: 'pw/chime' };
  let response: ChimeResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as ChimeResponse | undefined;
  } finally {
    if (opened && extracting === 0) await closeOffscreen();
  }
  return response ?? { ok: false, message: 'The offscreen document did not answer.' };
}
