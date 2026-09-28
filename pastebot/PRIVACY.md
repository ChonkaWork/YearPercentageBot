# Pastebot privacy policy

Last updated: 28 September 2026

Pastebot turns text you select on a web page into a prompt for an AI tool and puts it on your
clipboard. It works entirely inside your browser. It has no server, no account, no analytics
and no advertising, and it makes no network requests.

## What Pastebot reads, and when

- **The text you select**, as plain text. It is read only when you ask for it: the right-click
  menu, the keyboard shortcut or the toolbar button. Pastebot has no access to your pages
  otherwise. It uses Chrome's `activeTab` permission, which covers only the tab you invoked it
  on, and only at that moment.
- **The title and address of that page**, at the same moment, so your history shows where a
  prompt came from. They go into the prompt itself only if you turn on "Include page title &
  URL". Tracking parameters (such as `utm_source` or `fbclid`) and parameters that look like
  secrets (such as `token`, `session` or `code`) are removed from the address first. Addresses
  that aren't web pages (such as `file://`) are never used.
- **Text you type or paste** into the popup.

## What Pastebot stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Pastebot or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| Your settings and plan (free or Pro) | `chrome.storage.local` | Until you uninstall |
| Prompt history (each prompt, its action or template name, the first words of the source text, the page title and address) | `chrome.storage.local` | Until you delete them, clear history or uninstall. You can turn history off or lower its size in Settings. |
| Your custom templates and the last custom instruction you typed | `chrome.storage.local` | Until you delete them or uninstall |
| A selection handed from the page to the popup (when a page can't show Pastebot's panel) | `chrome.storage.session` (memory only) | Removed when the popup reads it, ignored after 5 minutes, gone when the browser closes |

Uninstalling Pastebot deletes all of it.

## What Pastebot shares

Nothing. Pastebot doesn't send, sell or share any data, and it contains no third-party code
that could. Your text leaves your computer only when you paste the prompt somewhere yourself,
and then the privacy policy of that service applies.

## Permissions

- `activeTab`, `scripting`: read the selection and show the Pastebot panel on the tab you
  invoked it on, only when you do.
- `contextMenus`: the Pastebot right-click menu.
- `storage`: settings, history and templates, as described above.
- `offscreen`, `clipboardWrite`: put the prompt on your clipboard.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Pastebot's single purpose,
is never transferred to anyone, and is never used for advertising, credit decisions or any
purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Pastebot is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Pastebot's Chrome Web Store page.
