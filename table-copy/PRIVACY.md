# Table Copy privacy policy

Last updated: 28 September 2026

Table Copy exports tables and data grids from web pages as CSV, TSV, Markdown, JSON or .xlsx.
It works entirely inside your browser. It has no server, no account, no analytics and no
advertising, and it makes no network requests.

## What Table Copy reads, and when

- **The tables on the current page**, only when you use Table Copy there: the right-click menu,
  the keyboard shortcut or the toolbar button. It uses Chrome's `activeTab` permission, which
  covers only that tab and only at that moment. It has no always-on scripts on web pages.
- For a table you add to the basket or record, also **the page title and address**, so you can
  tell the tables apart later.
- **Record rows**: only when you start it on a table, Table Copy watches that one table on that
  page for new rows (as you scroll it or page through it) until you stop, close the tab or leave
  the page. It reads nothing else on the page.
- When you open the popup, hovering a table's card draws an outline around that table on the
  page. Nothing is read for that beyond finding the table again.

## What Table Copy stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Table Copy or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| `settings`: CSV delimiter, number handling, merge options, the popup's format and "Keep links" | `chrome.storage.local` | Until you uninstall |
| `plan`: free or Pro | `chrome.storage.local` | Until you uninstall |
| `basket`: tables you chose to collect (their cell text, links you chose to keep, the page title and address) | `chrome.storage.local` | Until you remove them, clear the basket or uninstall |
| `recording`: the last "Record rows" recording (the recorded cell text and the addresses of cells that are links, the table's title, the page title and address, when it started) | `chrome.storage.local` | Until you press Discard, start a new recording or uninstall |
| `notice`: a short message for the popup when a page can't show one | `chrome.storage.session` (memory only) | Removed when the popup shows it, gone when the browser closes |

Tables you copy without adding them to the basket or recording them are not stored. Files you
download (.xlsx, CSV, TSV, Markdown, JSON) are created on your device and saved where you choose.
Uninstalling Table Copy deletes all stored data. To delete data without uninstalling: remove
tables from the basket or press **Clear**, and press **Discard** on the recording, in the popup.

## What Table Copy shares

Nothing. Table Copy doesn't send, sell or share any data. The only third-party code it contains
is bundled (the fflate library for creating .xlsx files, fonts and icons) and makes no network
requests.

**Open in Google Sheets** copies the table to your clipboard and opens a new browser tab at
`https://sheets.new` (Google's address for a new, empty spreadsheet), exactly as if you clicked a
link. Table Copy sends no data to Google: the table reaches Google Sheets only if you paste it
there yourself. Google's own privacy policy applies to that tab.

## Permissions

- `activeTab`, `scripting`: read the tables on the tab you use Table Copy on, only when you do,
  and show the confirmation, the outline and the recording bar there.
- `contextMenus`: the Table Copy right-click menu.
- `storage`: settings, the basket and the last recording, as described above.
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
