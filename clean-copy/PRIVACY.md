# Clean Copy privacy policy

Last updated: 28 September 2026

Clean Copy puts clean plain text on your clipboard when you copy from a web page. It works
entirely inside your browser. It has no server, no account, no analytics and no advertising,
and it makes no network requests.

## What Clean Copy reads, and when

- **The text you select**, when you use Copy clean: the keyboard shortcut, the right-click menu
  or the toolbar button. It uses Chrome's `activeTab` permission, which covers only that tab and
  only at that moment.
- **On sites you add to auto-clean (Pro)**: when you copy there, Clean Copy reads what you are
  copying so it can clean it. It asks Chrome for access to each site separately, only when you
  add it, and gives the access back when you remove the site. It runs on no other site.

The copied text is processed in the page and put on your clipboard. It is never stored by
Clean Copy and never sent anywhere.

## What Clean Copy stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Clean Copy or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| Your settings (cleanup options, auto-clean options) and plan (free or Pro) | `chrome.storage.local` | Until you uninstall |
| The sites you added to auto-clean (host names only) | `chrome.storage.local` | Until you remove them or uninstall |
| Your custom cleanup rules | `chrome.storage.local` | Until you delete them or uninstall |
| A short message for the popup when a page can't show one | `chrome.storage.session` (memory only) | Removed when the popup shows it, gone when the browser closes |

Uninstalling Clean Copy deletes all of it.

## What Clean Copy shares

Nothing. Clean Copy doesn't send, sell or share any data, and it contains no third-party code
that could.

## Permissions

- `activeTab`, `scripting`: read the selection on the tab you invoke Copy clean on, only when
  you do; register the auto-clean script for the sites you added.
- `contextMenus`: the Copy clean right-click item.
- `storage`: settings, sites and rules, as described above.
- `offscreen`, `clipboardWrite`: put the clean text on your clipboard.
- Optional access to websites: never requested at install. Requested one site at a time when
  you add that site to auto-clean, and released when you remove it.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Clean Copy's single purpose,
is never transferred to anyone, and is never used for advertising, credit decisions or any
purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Clean Copy is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Clean Copy's Chrome Web Store page.
