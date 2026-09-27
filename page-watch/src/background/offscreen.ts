import type { ExtractRequest, ExtractResponse } from '../platform/messages';

/**
 * The service worker has no DOM, so fetched HTML is parsed in an offscreen document
 * (reason DOM_PARSER) with DOMParser, which never runs the page's scripts or loads its
 * resources. The document is opened on demand and closed when no check is running.
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
        reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
        justification: 'Parse the HTML of watched pages to extract their text.',
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

export async function extractInOffscreen(html: string, selectors: string[] | null): Promise<ExtractResponse> {
  await ensureDocument();
  const request: ExtractRequest = { target: 'offscreen', type: 'pw/extract', html, selectors };
  const response = (await chrome.runtime.sendMessage(request)) as ExtractResponse | undefined;
  if (!response) return { ok: false, message: 'The page parser did not answer.' };
  return response;
}
