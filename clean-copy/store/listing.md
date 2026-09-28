# Chrome Web Store listing: Clean Copy

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/clean-copy-<version>.zip`).

> **Name risk.** The store already has an extension called **"Clean Copy"** that does the same
> thing (copies selected text without formatting), plus "Clean Copied Text", "Copy Clean Text"
> and several "Copy as Plain Text" items. With the identical name this listing is hard to find
> and easy to confuse with the other one. Pick a distinct name before the first upload: change
> `name`, `short_name` and `action.default_title` in `static/manifest.json`, then re-run
> `node scripts/store-assets.mjs` and `npm run package`.

## Name

Clean Copy

## Short description (≤ 132 characters, same as the manifest)

Copy text without fonts, colors, links and invisible junk. See every change and undo it, or auto-clean every Ctrl+C.

## Category

Productivity (alternative: Tools)

## Detailed description

Copy text without the mess, and see exactly what was cleaned.

When you copy from a web page, the page's fonts, colors, links, hidden text and invisible
characters come along, and tracking junk rides along in every link (utm_source, fbclid, gclid).
Clean Copy gives you plain, tidy text instead, and never hides what it did.

See every change, undo any copy (free)
• Show changes: your text with every removal highlighted: tracking parameters struck through,
  invisible characters as small markers (ZWSP, SHY), merged line breaks marked.
• Undo: one click in the confirmation puts the original back on the clipboard, formatting
  included. Or use Restore original in the toolbar popup.
• The last copy is kept in memory only, until the next copy or until you close the browser;
  Forget removes it at once.

Copy clean, anywhere (free)
• Select text, press Alt+Shift+V or right-click → Copy clean.
• The toolbar button shows your selection already cleaned, with the removals highlighted and a
  Copy button; four switches: Merge lines, Keep bullets, Strip tracking, Collapse spaces.
• Clean clipboard: already copied something messy (from an app, a PDF, an AI chat)? One click
  cleans the text on your clipboard. There is also a keyboard command for it.

Clean AI text and documents (free, optional)
• Plain typography: curly quotes become straight, “…” becomes "...", special spaces become
  normal spaces, dashes become hyphens (or stay, your choice).
• Remove Markdown syntax: **bold**, # headings and * bullets become plain text, [links](…)
  become "text (address)". Code blocks stay as they are.
• Keep link addresses after the link text, if you want them.

Clean every copy, automatically (Pro)
• Pick the sites where you copy a lot. From then on, your normal Ctrl+C / Cmd+C there comes out
  clean. No shortcut, no menu, nothing new to learn. Or turn on All sites.
• A small blue ON badge on the toolbar icon shows where Ctrl+C is being cleaned.
• Works in tabs that are already open. Remove a site and it stops right away.
• Sites that append "Read more at: …" to your copy: their text is cleaned too, and one rule
  removes the line entirely.
• Text fields and editors are left alone unless you ask otherwise.
• Clean Copy asks for access to one site at a time, only when you add it, and gives the access
  back when you remove it.

Your own cleanup rules (Pro)
• Find and replace steps, in the order you set: plain text or regular expressions.
• Ready-made presets: "Read more at …" lines, "Sent from my iPhone", "Get Outlook for …",
  quoted reply lines, utm_source=chatgpt.com.
• A live preview shows the result as you type; broken or dangerously slow patterns are caught
  with a clear message before they run.

What "clean" means
• Only plain text goes on the clipboard: no fonts, colors, sizes or links when you paste.
• Only what you can see: hidden elements, screen-reader-only text and decorations are skipped.
• Zero-width spaces, soft hyphens and other invisible characters are removed.
• Paragraphs, lists and table rows keep their shape as plain text.

Private by design: everything runs on your computer. No account, no server, no analytics, no
network requests. Settings and rules stay in your browser; the last copy stays in memory.

Free vs Pro: Copy clean (shortcut, menu, popup), Undo and Show changes, Clean clipboard and all
cleanup options are free. Auto-clean on Ctrl+C (chosen sites or all sites) and custom rules are
Pro ($1.99 once). During early access, Pro is free for everyone.

## Single purpose

Put clean plain text on the clipboard when the user copies (or on request, clean the text
already on the clipboard): without the page's formatting, links, hidden text, invisible
characters or tracking parameters, showing what was removed and letting the user undo it;
optionally automatically on sites the user chooses and with the user's own find-and-replace
rules.

## Permission justifications

- **activeTab**: read the selection in the current tab only after the user uses the shortcut, the
  context menu item or the toolbar button there.
- **scripting**: inject the selection reader and the confirmation into that tab on demand, and
  register the auto-clean script for the sites the user added (and granted), or for all sites
  when the user turned on "All sites" and granted it.
- **contextMenus**: the "Copy clean" item on selected text.
- **storage**: the user's settings, auto-clean sites and rules, stored locally; the last clean
  copy (original and clean text, for Undo and "Show changes") in session storage, which is kept
  in memory only and cleared when the browser closes.
- **offscreen**: a hidden extension page that writes the clean text (or, for Undo, the original)
  to the clipboard for the background service worker, and reads it for "Clean clipboard" (the
  service worker has no clipboard access of its own).
- **clipboardWrite**: put the clean text on the clipboard, and the original back for Undo.
- **Optional clipboardRead**: never requested at install. Requested, after an explanation in the
  popup, the first time the user clicks "Clean clipboard", to read the text already on the
  clipboard, clean it and write it back. Used only when the user clicks that button or presses
  its (user-assigned) keyboard shortcut.
- **Optional host permissions (`*://*/*`)**: never requested at install. When the user adds a
  site to auto-clean, Clean Copy requests access to that single site (`*://site/*`) so it can
  clean normal copies there; removing the site releases the permission. The whole pattern is
  requested only when the user turns on "All sites" (and released when it is turned off).

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Page and clipboard text is processed
  locally at the moment of a copy and never transmitted. Only the last clean copy (its original
  text and HTML, the clean text and the list of changes) is kept, in `chrome.storage.session`
  (memory only, replaced by the next copy, cleared when the browser closes), so the user can undo
  it. Settings, auto-clean sites (host names) and rules are kept in `chrome.storage.local`.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If the form insists that data processed only on the device counts, tick **Website content**
  and say "processed locally at the moment of a copy, never transmitted; the last copy is kept in
  memory for Undo until the next copy or until the browser closes".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/clean-copy/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

Generated by `node scripts/store-assets.mjs` from the e2e screenshots (fixture pages are served
as `wiki.example.com`, so no test address shows).

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The popup: the selection already cleaned, removals highlighted inline, Copy clean and Clean clipboard |
| `assets/screenshot-2.png` | 1280×800 | Show changes and Restore original: a Markdown AI answer cleaned (syntax, quotes, dashes, tracking) |
| `assets/screenshot-3.png` | 1280×800 | Alt+Shift+V on an article: the note with what was removed and Undo |
| `assets/screenshot-4.png` | 1280×800 | Auto-clean on Ctrl+C: "Auto-clean is on here" in the popup (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Custom rules with presets and the live preview (Pro) |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

- [ ] Load `release/clean-copy-<version>.zip` unpacked in normal Chrome.
- [ ] Alt+Shift+V and right-click → Copy clean on a news article, a Wikipedia page and a page
      with copy attribution ("Read more at: …"); paste into Gmail and Google Docs: no fonts,
      colors or links.
- [ ] Auto-clean: add a site from the popup, accept Chrome's permission prompt, press Ctrl+C
      there; the toolbar icon shows ON. Remove the site and check in `chrome://extensions` →
      Details → Site access that the access is gone. (Automation can't click the real prompt;
      this is unverified.)
- [ ] All sites: turn it on (accept the prompt), copy on a site not in the list; turn it off and
      check that Site access goes back to the listed sites only (unverified: automation can't
      grant or revoke optional access).
- [ ] Clean clipboard: first click shows the explanation, then Chrome's "Read data you copy and
      paste" prompt; accept and check the clipboard is cleaned. Try once with the popup closing
      during the prompt: the page should show "Clipboard cleaned" (or the badge) anyway.
      Remove access in Settings and check it is gone on `chrome://extensions`.
- [ ] Undo after Copy clean on a formatted article, then paste into Google Docs: the original
      formatting (bold, links, colors) comes back.
- [ ] macOS: Option+Shift+V and Cmd+C with auto-clean.
- [ ] Google Docs and Notion with "Also clean copies inside text fields and editors" off: copying
      there is left alone.

## Notes for the reviewer

Select text on any web page and press Alt+Shift+V (or right-click → Copy clean): clean plain text
is on the clipboard and a small note says what was removed; its Undo button puts the original
back. The toolbar popup's "Last copy" view shows the changes. "Clean clipboard" in the popup
asks for the optional clipboardRead permission the first time (after an explanation). Auto-clean:
in the popup, turn on "Clean every copy on <site>"; Chrome asks for access to that one site. No
account or login is needed.

## Distinct from Universal Copy (store duplicate-functionality policy)

Clean Copy's primary feature is automatic cleaning of ordinary copies (Ctrl+C on chosen sites,
custom rules), with every change shown and undoable. It has one output, clean plain text, and no
Markdown, HTML or table formats (it removes Markdown syntax, it never produces it).
Different name, icon (blue clipboard), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
