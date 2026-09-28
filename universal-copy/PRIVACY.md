# Universal Copy privacy policy

Last updated: 28 September 2026

Universal Copy converts what you select on a web page (or the page's main article) into
Markdown, clean text, clean HTML, a quote with a link to the passage, or a table format, and
puts it on your clipboard or saves it as a file. It works entirely inside your browser. It has
no server, no account, no analytics and no advertising, and it makes no network requests.

## What Universal Copy reads, and when

Universal Copy reads a page only when you use it on that page: the right-click menu, one of its
keyboard shortcuts, or the toolbar button. It uses Chrome's `activeTab` permission, which covers
only the tab you invoked it on, at that moment. It has no content scripts that run on pages by
themselves.

- **The selection**: the selected text with its structure (headings, lists, links, tables,
  code, formulas), only what is visible. Password fields are never read.
- **For "Copy as quote with link"**: the page's visible text, to find words that point to the
  quoted passage and nowhere else on the page. This runs inside the page; only the finished
  link (for example `#:~:text=We%20are%20bringing`) leaves it, as part of the quote you copy.
- **For "Copy article"**, and in the toolbar popup when nothing is selected: the page's visible
  content, to pick out the main article and leave out menus, ads and banners.
- **The tables on the page** (in the toolbar popup): their size, caption and first rows, to
  list them.
- **The page title and address**, for the link in quotes, "Copy page link as Markdown" and file
  names. Tracking parameters (such as `utm_source` or `fbclid`) are removed from the address.
  Only `http` and `https` addresses are used.
- **Author, publication date, description and site name** from the page's own metadata (meta
  tags, schema.org data, a `<time>` element), in the toolbar popup, for front matter in `.md`
  downloads.

Everything above is converted inside your browser. None of it is stored, except what you
download or copy yourself.

## What Universal Copy stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Universal Copy or sent anywhere.

| Key | What it holds | Where | How long |
| --- | --- | --- | --- |
| `settings` | Your settings: what the first shortcut copies, link addresses in clean text, list bullet and italic marker, CSV delimiter, quote style, front matter on/off, your front matter template and default tags | `chrome.storage.local` | Until you uninstall |
| `plan` | Free or Pro (set by a future license check; not used yet) | `chrome.storage.local` | Until you uninstall |
| `popup` | The last format you used in the toolbar popup (for the selection and for tables) | `chrome.storage.local` | Until you uninstall |
| `notice` | The last message about a copy, when a page couldn't show it (for example on `chrome://` pages), so the popup can show it | `chrome.storage.session` (memory only) | Removed when the popup shows it, ignored after 10 minutes, gone when the browser closes |

No copied text, page content, quotes, links or history are stored. Uninstalling Universal Copy
deletes all of the above. To reset your settings earlier, remove and reinstall the extension.

## Files and the clipboard

- Copies go to your clipboard (as text, and as HTML for rich editors). Universal Copy never
  reads your clipboard.
- Downloads (`.md`, `.csv`, `.json`) are created inside the extension from the converted text
  and saved to your usual download folder by Chrome. Nothing is uploaded.

## What Universal Copy shares

Nothing. Universal Copy doesn't send, sell or share any data, and it contains no third-party
code that could. Fonts and icons are bundled. What you copy leaves your computer only when you
paste it somewhere yourself, and then the privacy policy of that service applies. A quote's link
points to the page you quoted; whoever opens it visits that page.

## Permissions

- `activeTab`, `scripting`: read the selection, the article or the tables of the tab you invoked
  Universal Copy on, and show the small confirmation there, only when you do.
- `contextMenus`: the Universal Copy right-click menu.
- `storage`: settings, the last popup formats and a short-lived message, as described above.
- `offscreen`, `clipboardWrite`: put the converted text on your clipboard.

No host permissions, no `tabs`, `history` or `downloads` permission.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Universal Copy's single
purpose, is never transferred to anyone, and is never used for advertising, credit decisions or
any purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Universal Copy is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Universal Copy's Chrome Web Store page.
