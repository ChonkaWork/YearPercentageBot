/**
 * Why the popup can't reach a tab's content script, from the tab URL when Chrome shares it
 * (it may not; then a generic explanation is given). Pure.
 */
export function unavailableReason(url: string | undefined): string {
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return "Chrome doesn't allow extensions on its own pages (like chrome://) or on the Chrome Web Store. If this is a regular website, reload the page.";
  }
  const host = parsed.hostname;
  if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    return "Chrome doesn't allow extensions on the Chrome Web Store.";
  }
  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
      return 'This tab was opened before Video Speed+ was installed or updated. Reload the page to use it here.';
    case 'file:':
      return 'To use Video Speed+ on local files, turn on “Allow access to file URLs” for it on chrome://extensions, then reload the page.';
    default:
      return "Chrome doesn't allow extensions on its own pages (like chrome://), on other extensions' pages or in the PDF viewer.";
  }
}
