# Chrome Web Store listing: Clean Copy

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

## Data usage (privacy practices form)

- Collects no user data. Page text is processed locally only at the moment of a copy and is
  never stored or transmitted.
- No remote code; all code and assets are in the package.

## Screenshots (1280×800, from `screenshots/`)

1. `toast-light.png`: a selection copied clean, with what was removed.
2. `auto-clean-toast.png`: a normal Ctrl+C on an auto-clean site.
3. `popup-light.png`: live preview of the cleaned selection and the auto-clean switch.
4. `rules-light.png`: custom rules with the live preview.
5. `options-light.png` / `options-dark.png`: settings.

Popup and rules screenshots need to be placed on a 1280×800 canvas before upload.

## Distinct from Universal Copy (store duplicate-functionality policy)

Clean Copy's primary feature is automatic cleaning of ordinary copies (Ctrl+C on chosen sites,
custom rules). It has one output, clean plain text, and no Markdown, HTML or table formats.
Different name, icon (blue clipboard), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
