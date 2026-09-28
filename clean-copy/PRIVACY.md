# Clean Copy privacy policy

Last updated: 28 September 2026

Clean Copy puts clean plain text on your clipboard when you copy from a web page, shows what it
removed and lets you undo it. It works entirely inside your browser. It has no server, no
account, no analytics and no advertising, and it makes no network requests.

## What Clean Copy reads, and when

- **The text you select**, when you use Copy clean: the keyboard shortcut, the right-click menu
  or the toolbar button. It uses Chrome's `activeTab` permission, which covers only that tab and
  only at that moment.
- **On sites you add to auto-clean (Pro)**: when you copy there, Clean Copy reads what you are
  copying so it can clean it. It asks Chrome for access to each site separately, only when you
  add it, and gives the access back when you remove the site. It runs on no other site, unless
  you turn on **All sites**: then it asks Chrome for access to all sites and cleans copies
  everywhere; turning All sites off gives that access back.
- **Your clipboard**, only when you click **Clean clipboard** in the toolbar popup or use its
  keyboard shortcut, and only after you allowed it: the first time, Clean Copy explains what it
  does and Chrome asks you to confirm the optional "Read data you copy and paste" permission.
  It reads the clipboard's text (and HTML, if any), cleans the text and writes it back. You can
  remove this permission in Clean Copy's settings (Keyboard shortcuts → Remove access) or on
  `chrome://extensions`.

The copied text is processed in the page (or, for the clipboard, in the extension) and put on
your clipboard. It is never sent anywhere. The only copy Clean Copy keeps is the **last clean
copy**, in memory, so you can undo it (see below).

## What Clean Copy stores

Everything is stored with Chrome's extension storage on your device. Nothing is synced by
Clean Copy or sent anywhere.

| Data | Storage key | Where | How long |
| --- | --- | --- | --- |
| Your settings (cleanup options, auto-clean options) | `settings` | `chrome.storage.local` | Until you uninstall |
| Your plan (free or Pro) | `plan` | `chrome.storage.local` | Until you uninstall |
| The sites you added to auto-clean (host names only) | `sites` | `chrome.storage.local` | Until you remove them or uninstall |
| Whether auto-clean runs on all sites (on/off) | `allSites` | `chrome.storage.local` | Until you change it or uninstall |
| Your custom cleanup rules | `rules` | `chrome.storage.local` | Until you delete them or uninstall |
| **The last clean copy**, for Undo and Show changes: the original text and, when there was one, its HTML (what a normal copy would have given, from the page or the clipboard), the clean text, the list of changes (what was removed or added, and why), when it was made, how (shortcut, menu, popup, auto-clean or Clean clipboard) and the host name of the page | `lastCopy` | `chrome.storage.session`: **memory only**, never written to disk, not readable by web pages or by Clean Copy's scripts in pages | Replaced by the next clean copy (only the last one is kept); gone when the browser closes; **Forget** in the toolbar popup removes it at once |
| A short message for the popup when a page can't show one | `notice` | `chrome.storage.session` (memory only) | Removed when the popup shows it, gone when the browser closes |
| "Clean the clipboard once access is granted" (a time stamp, set when you click Allow and clean) | `pendingClipboard` | `chrome.storage.session` (memory only) | Removed when used; ignored after two minutes; gone when the browser closes |
| Whether "Show changes" is on in the popup | `cc-show-changes` | the popup's `localStorage` (this browser) | Until you uninstall |

Originals larger than 500,000 characters are not kept (Undo isn't offered for them); HTML larger
than 1,000,000 characters is not kept (Undo then restores the text only).

Uninstalling Clean Copy deletes all of it.

## What Clean Copy shares

Nothing. Clean Copy doesn't send, sell or share any data, and it contains no third-party code
that could.

## Permissions

- `activeTab`, `scripting`: read the selection on the tab you invoke Copy clean on, only when
  you do; register the auto-clean script for the sites you added.
- `contextMenus`: the Copy clean right-click item.
- `storage`: settings, sites and rules, and the last clean copy in memory, as described above.
- `offscreen`, `clipboardWrite`: put the clean text on your clipboard, and the original back when
  you click Undo or Restore original.
- Optional `clipboardRead`: never requested at install. Requested (after an explanation) the
  first time you click Clean clipboard; used only when you click it or use its shortcut.
- Optional access to websites: never requested at install. Requested one site at a time when
  you add that site to auto-clean, and released when you remove it; access to all sites is
  requested only when you turn on All sites, and released when you turn it off.

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
