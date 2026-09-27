export interface PageChange {
  /** The URL changed without a page load (single-page-app navigation). */
  navigated: boolean;
  /** <html>/<body> attributes changed (e.g. a theme switch). */
  attributes: boolean;
}

/**
 * Calls `onChange` (at most every `interval` ms) when the page's DOM changes, when the URL
 * changes without a page load, and when <html>/<body> attributes change. The observer callbacks
 * only set a flag and a timer, so a streaming reply that mutates the DOM constantly costs next
 * to nothing.
 */
export function watchPage(onChange: (change: PageChange) => void, interval = 400): () => void {
  let href = location.href;
  let timer: number | undefined;
  let attributesChanged = false;

  const run = () => {
    timer = undefined;
    const change = { navigated: location.href !== href, attributes: attributesChanged };
    href = location.href;
    attributesChanged = false;
    onChange(change);
  };
  const schedule = (delay: number) => {
    if (timer === undefined) timer = window.setTimeout(run, delay);
  };
  const onNavigate = () => {
    window.clearTimeout(timer);
    timer = undefined;
    schedule(50);
  };

  const content = new MutationObserver(() => schedule(interval));
  content.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  const attributes = new MutationObserver(() => {
    attributesChanged = true;
    schedule(interval);
  });
  const attributeFilter = ['class', 'style', 'data-theme', 'data-mode'];
  attributes.observe(document.documentElement, { attributes: true, attributeFilter });
  if (document.body) attributes.observe(document.body, { attributes: true, attributeFilter });

  // The Navigation API reports pushState navigations of the page's own router.
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigatesuccess', onNavigate);
  window.addEventListener('popstate', onNavigate);

  return () => {
    window.clearTimeout(timer);
    content.disconnect();
    attributes.disconnect();
    navigation?.removeEventListener('navigatesuccess', onNavigate);
    window.removeEventListener('popstate', onNavigate);
  };
}
