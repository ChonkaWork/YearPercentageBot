# Chrome Web Store listing: Universal Copy

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs` after `npm run screenshots`), the package with
`npm run package` (`release/universal-copy-<version>.zip`).

> **Name check.** The Web Store couldn't be searched from the build environment, so whether
> another extension is already called "Universal Copy" is **unverified**. Search the store
> before the first upload; a longer, searchable name such as "Universal Copy: Markdown, quotes
> with links" also helps. To rename: `name`, `short_name` (≤ 12 characters; currently 14, which
> the store may truncate) and `action.default_title` in `static/manifest.json`, then re-run
> `node scripts/store-assets.mjs` and `npm run package`.

> **Duplicate functionality.** Universal Copy, Clean Copy and Table Copy must stay distinct
> (see `docs/MONETIZATION.md`). This listing is about **any selection or article → the format
> you need, with citations**: Markdown, quotes with deep links, whole articles, math. Tables are
> one feature among several and are described last; automatic clean Ctrl+C (Clean Copy) and
> .xlsx / column picker / merging (Table Copy) are not part of it. Don't publish all three on
> the same day (`docs/LAUNCH.md`).

## Name

Universal Copy

## Short description (manifest `description`, ≤ 132 characters)

Copy any selection or article as Markdown, clean text or HTML, or as a quote with a link to the passage. Tables as CSV, TSV, JSON.

## Category and language

Productivity → Tools. Language: English.

## Detailed description

Copy what you read in the format you need, with a link back to exactly where it came from.

Quote with a link to the passage
• Select a sentence, press Alt+Q (or right-click → Universal Copy → Copy as quote with link).
• You get the quote and the page title, linked. Whoever opens the link lands on that passage,
  scrolled into view and highlighted. It works in Chrome, Edge, Safari and Firefox.
• If the same words appear earlier on the page, the link adds the words around them, so it
  still finds the right place.
• Markdown for notes and AI chats, plain text for chat apps and email, and a formatted quote
  with a clickable link for Google Docs, Word and email.

Whole articles as Markdown
• No selecting: right-click the page → Copy article as Markdown, or open the toolbar popup.
• Menus, sidebars, ads, cookie banners, share buttons and related links stay behind; the
  headline, text, lists, code, tables, images and links come along.

Any selection, any format
• Markdown: headings, bold and italic, links, images, nested lists, task lists, code blocks
  with their language, quotes and tables.
• Math as LaTeX: formulas rendered with KaTeX or MathJax become $…$ and $$…$$.
• Clean text without the site's formatting, and clean HTML that keeps the structure.
• The toolbar popup shows a preview in the chosen format that you can edit before copying,
  with word and token counts for AI tools.

Tables
• Every table on the page as CSV, TSV (pastes into Excel and Google Sheets as cells), Markdown
  or JSON. Merged cells are expanded; the format you used last is one click.

Pro
• Download the selection or the article as a .md file, with front matter for Obsidian and other
  note apps: title, address, author, publication date, clip date and your tags, from a
  template you edit.
• Download tables as .csv or .json, copy the page link as Markdown, Markdown presets.
• Pro is $2.99 once. During early access, every Pro feature is free.

Private by design: Universal Copy runs entirely in your browser. No account, no server, no
analytics, no network requests. It reads a page only when you use it there, and it keeps no
copy of what you copy.

## Single purpose

Convert content the user chooses on a web page (a selection, the page's main article or a
table) into a portable format (Markdown, clean text, clean HTML, a quote with a link to the
passage, CSV, TSV or JSON) and put it on the clipboard or save it as a file.

## Permission justifications

- **activeTab**: read the selection, the article, the tables and the title and address of the
  current tab, only after the user invokes Universal Copy there (context menu, keyboard
  shortcut or toolbar button).
- **scripting**: inject the page reader and the small confirmation message into that tab on
  demand. No content scripts run on pages otherwise.
- **contextMenus**: the Universal Copy items on selected text (copy as text, Markdown, HTML,
  quote with link, table formats, page link) and on the page (copy article, copy page link).
- **storage**: the user's settings, the last format used in the popup, and a short-lived
  message for the popup (session storage) when a page can't show one.
- **offscreen**: a hidden extension page that writes to the clipboard for the background
  service worker, which has no clipboard access of its own.
- **clipboardWrite**: put the converted text (and HTML for rich editors) on the clipboard.

No host permissions. No `tabs`, `downloads` or `history` permission: downloads are saved from
the popup with a standard download link.

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Page content is converted locally
  when the user asks and goes only to the clipboard or a file the user saves. Settings and the
  last popup formats are kept in `chrome.storage.local`.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If a reviewer or the form insists that content processed on the device counts, tick
  **Website content** and say "processed locally when the user invokes the extension, never
  stored or transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/universal-copy/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | Quote with link: the popup's Quote preview next to the linked page, scrolled to the highlighted passage |
| `assets/screenshot-2.png` | 1280×800 | Whole article as Markdown with the front matter for .md downloads (Pro) |
| `assets/screenshot-3.png` | 1280×800 | Lecture notes selected: Markdown with formulas as LaTeX |
| `assets/screenshot-4.png` | 1280×800 | Compact table list, one table opened with its preview and formats |
| `assets/screenshot-5.png` | 1280×800 | Dark mode popups; privacy |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

All screenshots are the e2e test's captures of the real UI on local fixture pages served under
example host names (`news.example.com`, `docs.example.org`, `notes.example.edu`...).

## Check by hand before submitting

The e2e test covers every flow on local fixture pages in real Chromium; these need a real
browser and real sites (the build environment can't reach them):

- [ ] Load `release/universal-copy-<version>.zip` unpacked (unzip, Load unpacked) in normal Chrome.
- [ ] Alt+Q on a news article, a Wikipedia article and a GitHub README: open each copied link
      in a new tab and check it lands on the passage, highlighted. Also on a page where the
      quoted words repeat (a comment thread).
- [ ] Open a copied link in Firefox and Safari (text fragments are supported there too).
- [ ] Copy article as Markdown on a real news site, a docs site (MDN, a framework's docs) and a
      blog: no menus, cookie banners or "related" lists; headline and body complete.
- [ ] Formulas on a KaTeX page, a MathJax page (math.stackexchange.com) and Wikipedia.
- [ ] Download .md and open it in Obsidian: the front matter shows as properties.
- [ ] Alt+C and Alt+Q are assigned in `chrome://extensions/shortcuts`; on macOS check what
      Chrome assigns (Alt is Option there).
- [ ] Take one or two screenshots on real sites if they look better than the fixture ones.

## Notes for the reviewer

Select a sentence on any normal web page and press Alt+Q (or right-click → Universal Copy →
Copy as quote with link): the quote and a link to that passage are on the clipboard. Right-click
an empty part of a page → Copy article as Markdown. The toolbar button opens the popup with a
preview. No account or login is needed.
