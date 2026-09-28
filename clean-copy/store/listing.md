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

Copy text without fonts, colors, links and invisible junk. Auto-clean every Ctrl+C on the sites you choose.

## Category

Productivity (alternative: Tools)

## Detailed description

Copy text without the mess.

When you copy from a web page, the page's fonts, colors, links, hidden text and invisible
characters come along, and tracking junk rides along in every link (utm_source, fbclid, gclid).
Clean Copy gives you plain, tidy text instead.

Clean every copy, automatically (Pro)
• Pick the sites where you copy a lot. From then on, your normal Ctrl+C / Cmd+C there comes out
  clean. No shortcut, no menu, nothing new to learn.
• Works in tabs that are already open. Remove a site and it stops right away.
• Sites that append "Read more at: …" to your copy: their text is cleaned too, and one rule
  removes the line entirely.
• Text fields and editors are left alone unless you ask otherwise.
• Clean Copy asks for access to one site at a time, only when you add it, and gives the access
  back when you remove it.

Your own cleanup rules (Pro)
• Find and replace steps, in the order you set: plain text or regular expressions.
• A live preview shows the result as you type; broken or dangerously slow patterns are caught
  with a clear message before they run.
• Examples: drop "Sent from my iPhone", remove "Read more" lines, reformat phone numbers, put
  one item per line.

Copy clean, anywhere (free)
• Select text, press Alt+Shift+V or right-click → Copy clean.
• A small note confirms it and tells you what was removed.
• The toolbar button shows your selection already cleaned, with a Copy button.
• Options: keep or merge line breaks (great for text copied from PDFs and emails), keep or drop
  list bullets, remove tracking parameters from any web address in the text, collapse extra
  spaces.

What "clean" means
• Only plain text goes on the clipboard: no fonts, colors, sizes or links when you paste.
• Only what you can see: hidden elements, screen-reader-only text and decorations are skipped.
• Zero-width spaces, soft hyphens and other invisible characters are removed.
• Paragraphs, lists and table rows keep their shape as plain text.

Private by design: everything runs on your computer. No account, no server, no analytics, no
network requests. Settings and rules stay in your browser.

Free vs Pro: Copy clean (shortcut, menu, popup) and all cleanup options are free. Auto-clean on
Ctrl+C and custom rules are Pro ($1.99 once). During early access, Pro is free for everyone.

## Single purpose

Put clean plain text on the clipboard when the user copies: without the page's formatting,
links, hidden text, invisible characters or tracking parameters, optionally automatically on
sites the user chooses and with the user's own find-and-replace rules.

## Permission justifications

- **activeTab**: read the selection in the current tab only after the user uses the shortcut, the
  context menu item or the toolbar button there.
- **scripting**: inject the selection reader and the confirmation into that tab on demand, and
  register the auto-clean script for the sites the user added (and granted).
- **contextMenus**: the "Copy clean" item on selected text.
- **storage**: the user's settings, auto-clean sites and rules, stored locally.
- **offscreen**: a hidden extension page that writes the clean text to the clipboard for the
  background service worker (which has no clipboard access of its own).
- **clipboardWrite**: put the clean text on the clipboard.
- **Optional host permissions (`*://*/*`)**: never requested at install. When the user adds a
  site to auto-clean, Clean Copy requests access to that single site (`*://site/*`) so it can
  clean normal copies there; removing the site releases the permission.

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Page text is processed locally only at
  the moment of a copy and is never stored or transmitted. Settings, auto-clean sites (host names)
  and rules are kept in `chrome.storage.local`.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If the form insists that data processed only on the device counts, tick **Website content**
  and say "processed locally at the moment of a copy, never stored or transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/clean-copy/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

Generated by `node scripts/store-assets.mjs` from the e2e screenshots (fixture pages are served
as `wiki.example.com`, so no test address shows).

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The popup: the selection already cleaned, quick options |
| `assets/screenshot-2.png` | 1280×800 | Alt+Shift+V on an article, with what was removed |
| `assets/screenshot-3.png` | 1280×800 | Auto-clean on Ctrl+C: the site list (Pro) |
| `assets/screenshot-4.png` | 1280×800 | Cleanup options with a before/after example |
| `assets/screenshot-5.png` | 1280×800 | Custom rules with the live preview (Pro) |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

- [ ] Load `release/clean-copy-<version>.zip` unpacked in normal Chrome.
- [ ] Alt+Shift+V and right-click → Copy clean on a news article, a Wikipedia page and a page
      with copy attribution ("Read more at: …"); paste into Gmail and Google Docs: no fonts,
      colors or links.
- [ ] Auto-clean: add a site from the popup, accept Chrome's permission prompt, press Ctrl+C
      there. Remove the site and check in `chrome://extensions` → Details → Site access that the
      access is gone. (Automation can't click the real prompt; this is unverified.)
- [ ] macOS: Option+Shift+V and Cmd+C with auto-clean.
- [ ] Google Docs and Notion with "Also clean copies inside text fields and editors" off: copying
      there is left alone.

## Notes for the reviewer

Select text on any web page and press Alt+Shift+V (or right-click → Copy clean): clean plain text
is on the clipboard and a small note says what was removed. Auto-clean: in the popup, turn on
"Clean every copy on <site>"; Chrome asks for access to that one site. No account or login is
needed.

## Distinct from Universal Copy (store duplicate-functionality policy)

Clean Copy's primary feature is automatic cleaning of ordinary copies (Ctrl+C on chosen sites,
custom rules). It has one output, clean plain text, and no Markdown, HTML or table formats.
Different name, icon (blue clipboard), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
