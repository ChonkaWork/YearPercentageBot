# Chat Exporter privacy policy

Last updated: 28 September 2026

Chat Exporter saves ChatGPT and Claude conversations as files (Markdown, plain text, HTML,
Obsidian / Notion Markdown, JSON, PDF) or copies them to your clipboard, and turns the data
export that ChatGPT or Claude email you into Markdown files. It works entirely inside your
browser. It has no server, no account, no analytics and no advertising, and it makes no network
requests.

## What Chat Exporter reads, and when

- **The conversation you have open** on `chatgpt.com`, `chat.openai.com` or `claude.ai`, read
  from the page (not from the sites' servers) when you open the Export menu or the toolbar popup,
  and when you export, copy or select messages. Chat Exporter runs on those three sites only; it
  checks whether the page shows a conversation so it can show its Export button there. Other
  sites are never touched.
- **An export file you choose**: on the options page, the zip (or `conversations.json`) you pick
  or drop is read in that page, on your computer. Only `conversations.json` is read from a zip.
  The file and the zip made from it are kept in memory while the page is open (for "Download
  again") and are gone when you close it. Nothing from it is stored or sent anywhere.

## What Chat Exporter stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by Chat
Exporter or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| `settings`: whether to show the Export button on chat pages, and your export options (include code blocks, include your messages, last N messages, file name template, tags, callouts) | `chrome.storage.local` | Until you uninstall |
| `plan`: free or Pro (only written by a future payments step; see Paid features) | `chrome.storage.local` | Until you uninstall |
| `print:<id>`: a conversation handed to the print view when you choose PDF | `chrome.storage.session` (memory only) | The 5 most recent are kept; all gone when the browser closes |

The files you export are saved by Chrome to your downloads folder, like any download, and the
text you copy goes to your clipboard. Uninstalling Chat Exporter deletes everything in the
table. Your exported files are yours and stay where you saved them.

## What Chat Exporter shares

Nothing. Chat Exporter doesn't send, sell or share any data, and it contains no third-party code
that could. The extension makes no network requests. Exported files contain a link to the
original conversation, which is only opened if you click it. A conversation leaves your computer
only when you send an exported file or paste a copied prompt somewhere yourself, and then the
privacy policy of that service applies.

## Permissions

- `storage`: the settings and plan, and the short-lived hand-off to the print view, as described
  above.
- Content script on `chatgpt.com`, `chat.openai.com` and `claude.ai`: shows the Export button
  and reads the open conversation when you export it. No other site.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Chat Exporter's single
purpose, is never transferred to anyone, and is never used for advertising, credit decisions or
any purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Chat Exporter is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Chat Exporter's Chrome Web Store page.
