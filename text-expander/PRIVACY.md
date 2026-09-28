# Snippets privacy policy

Last updated: 28 September 2026

Snippets (Snippets – Text Expander) turns short abbreviations you type, like `;sig`, into text
you saved, and can list your snippets under the caret while you type. It works entirely inside
your browser. It has no server, no account, no analytics and no advertising, and it makes no
network requests.

## What Snippets reads, and when

To expand abbreviations wherever you type, Snippets' content script runs on every site and in
every frame. It only reacts to typing in text fields (inputs, text areas, rich-text editors). It
never runs in password, one-time-code or credit-card fields, or in read-only and disabled
fields, and it does nothing on sites you paused.

- **A few characters before the caret.** When the character you just typed could end one of
  your abbreviations, Snippets reads as many characters before the caret as your longest
  abbreviation has, plus one, to see whether you typed an abbreviation. Nothing else in the
  field is read for this.
- **The word you are typing, for suggestions.** When you type a character that one of your
  abbreviations starts with (for example `;`), Snippets reads the current word before the caret,
  at most 42 characters, on each keystroke until the word ends, to list matching snippets. You
  can turn suggestions off in the manager.
- **The caret position.** To place the suggestion list or the fill-in form next to the caret
  in an input or text area, Snippets lays out an invisible copy of the field's text up to the
  caret inside its own isolated element, measures it and removes it at once.
- **Your clipboard, only for `{clipboard}`.** If a snippet contains `{clipboard}` and you
  allowed clipboard access (an optional permission Chrome asks you for when you save such a
  snippet), the clipboard's plain text is read at the moment that snippet is inserted or copied
  from the toolbar popup, and put into the snippet. It is never read at any other time and never
  stored. Without the permission, `{clipboard}` inserts nothing.
- **The current tab's address**, when you open the toolbar popup, to show and toggle "Expanding
  on this site" (Chrome's `activeTab` permission, only for the tab you opened the popup on).

Nothing you type is stored, logged or sent anywhere. Snippets never reads a page's other
content.

## What Snippets stores

Everything is stored with Chrome's extension storage (`chrome.storage.local`) on your device.
Nothing is synced by Snippets or sent anywhere.

| Key | What it holds | How long |
| --- | --- | --- |
| `snippets` | Your snippets: abbreviation, text, label, tags, created and edited times | Until you delete them or uninstall |
| `settings` | When snippets expand (as you type, or after Space/Tab/Enter), whether suggestions are on, the manager's sort order, and the sites where you paused Snippets (host names) | Until you change them or uninstall |
| `usage` | For each snippet: how many times it was inserted or copied, and when it was last used. Not what you typed, not where. | Until you uninstall. The count of a deleted snippet is dropped the next time any snippet is used. |
| `plan` | `free` or `pro`. This version never writes it; a future version with payments may. | Until you uninstall |

Export (in the manager) downloads your snippets as a JSON file on your computer; usage counts
are not included. Uninstalling Snippets deletes everything above.

## What Snippets shares

Nothing. Snippets doesn't send, sell or share any data, and it contains no third-party code that
could. Your text leaves the page only when you send it yourself (an email, a message, a form).

## Permissions

- Content script on all sites (`<all_urls>`, all frames): notice abbreviations and show
  suggestions as you type, as described above.
- `storage`: keep your snippets, settings and usage counts on your device.
- `activeTab`: read the address of the tab you open the popup on, to pause Snippets there.
- `clipboardRead` (optional, off until you allow it): fill in `{clipboard}`. You can remove it
  in the manager's Privacy card or at `chrome://extensions`.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Snippets' single purpose,
is never transferred to anyone, and is never used for advertising, credit decisions or any
purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Snippets is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Snippets' Chrome Web Store page.
