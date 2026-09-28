# Table Copy privacy policy

Last updated: 28 September 2026

Table Copy exports HTML tables from web pages as CSV, TSV, Markdown, JSON or .xlsx. It works
entirely inside your browser. It has no server, no account, no analytics and no advertising, and
it makes no network requests.

## What Table Copy reads, and when

- **The tables on the current page**, only when you use Table Copy there: the right-click menu,
  the keyboard shortcut or the toolbar button. It uses Chrome's `activeTab` permission, which
  covers only that tab and only at that moment. It has no always-on scripts on web pages.
- For a table you add to the basket, also **the page title and address**, so you can tell the
  tables apart later.

## What Table Copy stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Table Copy or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| Your settings (CSV delimiter, number handling, merge options) and plan (free or Pro) | `chrome.storage.local` | Until you uninstall |
| The basket: tables you chose to collect (their cell text, the page title and address) | `chrome.storage.local` | Until you remove them, clear the basket or uninstall |
| A short message for the popup when a page can't show one | `chrome.storage.session` (memory only) | Removed when the popup shows it, gone when the browser closes |

Tables you copy without adding them to the basket are not stored. Files you download (.xlsx,
CSV and others) are created on your device and saved where you choose. Uninstalling Table Copy
deletes all stored data.

## What Table Copy shares

Nothing. Table Copy doesn't send, sell or share any data. The only third-party code it contains
is bundled (the fflate library for creating .xlsx files, fonts and icons) and makes no network
requests.

## Permissions

- `activeTab`, `scripting`: read the tables on the tab you use Table Copy on, only when you do.
- `contextMenus`: the Table Copy right-click menu.
- `storage`: settings and the basket, as described above.
- `offscreen`, `clipboardWrite`: put the converted table on your clipboard.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Table Copy's single purpose,
is never transferred to anyone, and is never used for advertising, credit decisions or any
purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Table Copy is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Table Copy's Chrome Web Store page.
