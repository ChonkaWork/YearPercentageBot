# Chrome Web Store listing: Chat Exporter

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs` after `npm run test:e2e`), the package with
`npm run package` (`release/chat-exporter-<version>.zip`).

> **Name and marks.** "ChatGPT" and "Claude" are other companies' trademarks. They appear only to
> say which sites the extension works with (nominative use), never in the name, the icon or as
> logos. The screenshots are of fixture pages with a neutral look, not of OpenAI's or Anthropic's
> UI. Several listings are called "ChatGPT Exporter" or similar; "Chat Exporter" is generic, so
> search for exact duplicates before the first upload.

## Name

Chat Exporter

## Short description (manifest `description`, ≤ 132 characters)

Export ChatGPT and Claude chats to Markdown, HTML, PDF or JSON, or your whole history as notes. Everything stays in your browser.

## Category and language

Productivity → Tools. Language: English.

## Detailed description

Save your ChatGPT and Claude conversations the way you want them: one click from the chat, or
your whole history at once.

From the chat
• An Export button next to Share: Copy as Markdown, or download Markdown, plain text, HTML,
  Obsidian / Notion Markdown, JSON or PDF.
• Code blocks keep their language, tables stay tables, math stays as TeX, headings and lists
  survive. Site buttons like "Copy code" are left out.
• HTML: one self-contained file that opens anywhere, in light or dark, with a link back to the
  original. No scripts, nothing loaded from the web.
• Select messages: tick the messages you need right in the chat, then export only those.
• Continue in another AI: copies a ready hand-off prompt (recent messages in full, older ones
  shortened, code kept) with its size in tokens. Paste it into any other AI and carry on.

Your whole history (Pro)
• Ask ChatGPT (Settings → Data controls → Export data) or Claude (Settings → Privacy → Export
  data) for your data, and drop the zip you get onto Chat Exporter's options page.
• Every conversation becomes a Markdown file with its own created and updated dates, named with
  your template, plus an index.md listing them by date. One zip, ready for Obsidian, Notion or a
  folder of notes.
• Only the thread you actually saw is kept (not old edited branches). A summary tells you how
  many conversations and messages were exported and what was left out, and why.

More Pro
• Obsidian / Notion Markdown with YAML front matter, your tags, and callouts for each role.
• JSON (versioned) and PDF (a clean print view: Save as PDF).
• Export options: leave out code blocks or your own messages, only the last N messages, file
  names from a template like "{site} - {title}".

Private by design: Chat Exporter runs entirely in your browser. No account, no server, no
analytics, no network requests. It works only on chatgpt.com and claude.ai, reads the chat from
the page you have open, and reads an export file only in its own options page when you drop it
there. Nothing is uploaded.

Free vs Pro: copying, the hand-off prompt, message selection and .md, .txt and .html downloads
are free, with no limits. Your whole history, Obsidian / Notion Markdown, JSON, PDF and export
options are Pro ($2.99 once). During early access, Pro is free for everyone.

## Single purpose

Export the user's ChatGPT and Claude conversations to files or the clipboard: the conversation
open in the tab, selected messages of it, or the user's whole history from the data export file
the user provides.

## Permission justifications

- **storage**: the user's settings (show the Export button, export options) and plan, stored
  locally; a short-lived, memory-only hand-off of a conversation to the extension's print view
  (`chrome.storage.session`) when the user exports a PDF.
- **Content script on `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://claude.ai/*`**
  (host access): adds the Export button to the chat page and reads the open conversation from the
  page when the user exports it, copies it or selects messages. `chat.openai.com` is ChatGPT's
  former address, which still redirects there. No other sites; no `host_permissions`, no
  `<all_urls>`, no `scripting`, no `tabs`.

No other permissions: downloads use an `<a download>` link, copying uses the Clipboard API after
the user's click, and the export file is read from a file the user picks or drops.

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Conversations are read from the open
  page (or from an export file the user drops) and turned into files locally. Settings are kept
  in `chrome.storage.local`.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If a reviewer or the form insists that data handled only on the device counts, tick **Website
  content** and **Personal communications** (the user's chats) and say "processed locally only,
  never transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/chat-exporter/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The Export menu in a chat: copy, hand-off, select, six formats |
| `assets/screenshot-2.png` | 1280×800 | Your whole history (Pro): the summary after converting a 148-conversation export |
| `assets/screenshot-3.png` | 1280×800 | Select messages: checkboxes in the chat and the "2 selected · Export · Cancel" bar |
| `assets/screenshot-4.png` | 1280×800 | The standalone HTML export, light and dark |
| `assets/screenshot-5.png` | 1280×800 | The popup, light and dark, with "Continue in another AI" and its token count |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

The screenshots come from the e2e test on fixture pages and fixture exports (see the README).

## Check by hand before submitting

The e2e test covers every flow on local fixture pages and fixture export files; these need a
real browser, real accounts and real exports (all **unverified** so far):

- [ ] Load `release/chat-exporter-<version>.zip` unpacked (unzip, Load unpacked) in normal Chrome.
- [ ] chatgpt.com: a long conversation with code, a table and math. Export button next to Share;
      Markdown, HTML, JSON and PDF look right; Copy as Markdown pastes correctly.
- [ ] claude.ai: the same, plus a reply still being written, and navigating between chats.
- [ ] Select messages on a long conversation: checkboxes line up with the messages while
      scrolling and stay out of the site's header; export of two replies contains just those.
- [ ] Continue in another AI: paste the prompt into the other site (Claude ↔ ChatGPT) and check
      that it carries on sensibly; compare the token estimate with the site's count if it shows one.
- [ ] Request a real ChatGPT export and a real Claude export; drop each zip on the options page.
      Check the counts, what was left out, a few notes (dates, branches, images as `[image]`)
      and index.md, and open the folder in Obsidian. If the format changed, update
      `src/core/import/` and the fixtures.
- [ ] Light and dark themes of both sites; the popup on a chat, on another site and on a chat
      page opened before installing.
- [ ] Take one or two screenshots on the real sites if they look better than the fixture ones
      (without the sites' logos in the frame).

## Notes for the reviewer

Open any conversation on chatgpt.com or claude.ai (a free account is enough) and click
**Export** next to the Share button (or the toolbar button). Pick Markdown: a file is
downloaded. **Select messages…** shows checkboxes on the messages; **Continue in another AI**
copies a prompt. To try "Your whole history" without requesting an export, save
`https://raw.githubusercontent.com/ChonkaWork/YearPercentageBot/main/chat-exporter/e2e/fixtures/chatgpt-export.json`
as `conversations.json` and drop it on the extension's options page (Your whole history): a zip
with one Markdown file per conversation is downloaded. The extension makes no network requests
and needs no login of its own.
