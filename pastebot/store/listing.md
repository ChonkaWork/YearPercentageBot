# Chrome Web Store listing: Pastebot

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/pastebot-<version>.zip`).

> **Name risk.** Tapbots sells a Mac clipboard manager called **Pastebot** (Pastebot 3 launched in
> July 2026). Same name, neighbouring category (copy and paste). Expect confusion in search and a
> possible trademark complaint, which gets a listing taken down. Decide the store name before the
> first upload: changing it later loses the name users searched for. To rename, change `name`,
> `short_name` and `action.default_title` in `static/manifest.json`, then re-run
> `node scripts/store-assets.mjs` and `npm run package`.

## Name

Pastebot

## Short description (manifest `description`, ≤ 132 characters)

Turn selected text into a ready AI prompt: summarize, explain, analyze, rewrite. Copied in one step, for ChatGPT, Claude or Gemini.

## Category and language

Productivity → Tools. Language: English.

## Detailed description

Select text. Press Alt+P. Paste a ready prompt into your AI.

Pastebot turns whatever you select on a web page (an error message, an article, a code snippet,
a table, a job post) into a clear prompt for ChatGPT, Claude, Gemini, Cursor or any other AI
tool, and puts it on your clipboard. No more typing "summarize this" and pasting the text below
it, again and again.

How it works
• Select text, then right-click → Pastebot, or press Alt+P (⌘⇧P on Mac).
• Pick an action: Analyze, Summarize, Explain, Extract, Compare, Rewrite, or type your own
  instruction. Keys 1-7 pick them in the small panel next to your selection.
• The prompt is on your clipboard. Paste it wherever you talk to AI.

Prompts that work
• Errors and stack traces are recognised and fenced as code; Explain asks for the likely cause,
  the fix and how to prevent it.
• Code (with its language), JSON and tables are detected and fenced so the AI reads them right.
• Invisible characters, extra spaces and page junk are cleaned out first.
• Optionally add the page title and address (tracking and secret-looking parameters are removed).

The toolbar popup
• Starts from your selection, or paste text yourself.
• Pick an action, edit the prompt, copy.
• Your recent prompts are one click away.

Your own templates (Pro)
• Write an instruction once ("Explain this to a junior developer on my team"), put {content}
  where the text goes, and it appears in the right-click menu, the panel and the popup.

History search and pins (Pro)
• Keep up to 500 prompts, find one by any word, pin the ones you reuse.

Private by design: Pastebot runs entirely in your browser. No account, no server, no analytics,
no network requests. It reads a page only when you invoke it there. History and templates stay in
this browser. Pastebot doesn't answer anything itself and never sends your text to an AI: you
paste the prompt yourself.

Free vs Pro: every action, the panel, the popup and a history of 20 prompts are free. Custom
templates, a history of up to 500 prompts, search and pins are Pro ($2.99 once). During early
access, Pro is free for everyone.

## Single purpose

Turn text the user selects on a web page into a prompt for an AI tool and put it on the
clipboard, with built-in or user-defined instructions and a local history of the prompts made.

## Permission justifications

- **activeTab**: read the selected text, and the page title and address, in the current tab
  only after the user invokes Pastebot there (context menu, shortcut or toolbar button).
- **scripting**: inject the selection reader and the Pastebot panel into that tab on demand. No
  content scripts run on pages otherwise.
- **contextMenus**: the Pastebot items (Make Prompt, the actions, the user's templates) on
  selected text.
- **storage**: the user's settings, custom templates and prompt history, stored locally; a
  short-lived hand-off to the popup in session storage.
- **offscreen**: a hidden extension page that writes the prompt to the clipboard for the
  background service worker (which has no clipboard access of its own).
- **clipboardWrite**: put the prompt on the clipboard.

No host permissions.

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. The selected text is turned into a
  prompt locally; history (prompts, the first words of the source, page title and address) and
  templates are kept in `chrome.storage.local` and can be cleared or turned off.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If a reviewer or the form insists that data kept only on the device counts, tick **Website
  content** and **Web history** and say "stored locally only, never transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/pastebot/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The panel next to a selected stack trace |
| `assets/screenshot-2.png` | 1280×800 | "Prompt copied" with the generated prompt |
| `assets/screenshot-3.png` | 1280×800 | The popup: edit before you copy |
| `assets/screenshot-4.png` | 1280×800 | Custom template editor (Pro) |
| `assets/screenshot-5.png` | 1280×800 | History search and pins (Pro) |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

The e2e test covers every flow on local fixture pages; these need a real browser and real sites:

- [ ] Load `release/pastebot-<version>.zip` unpacked (unzip, Load unpacked) in normal Chrome.
- [ ] Right-click → Pastebot → Make Prompt on GitHub (an issue), Stack Overflow (a question with
      a stack trace) and a long news article. Panel appears next to the selection, prompt pastes
      correctly into ChatGPT or Claude.
- [ ] Alt+P on the same pages; on macOS check ⌘⇧P is assigned in `chrome://extensions/shortcuts`.
- [ ] A PDF in Chrome's viewer and a `chrome://` page: the popup takes over (no panel there).
- [ ] Google Docs: see what the context menu gets from a Docs selection; if nothing, note it as a
      known limitation.
- [ ] Take one or two screenshots on those real sites if they look better than the fixture ones.

## Notes for the reviewer

Select any text on a normal web page, right-click → Pastebot → Make Prompt… (or press Alt+P),
press 1. The prompt is now on the clipboard. The toolbar button opens the popup with history.
No account or login is needed.
