# Page Watch privacy policy

Last updated: 28 September 2026

Page Watch checks web pages you choose and tells you when they, or the part of them you picked,
change. It works entirely inside your browser. It has no server, no account, no analytics and
no advertising.

## What Page Watch reads, and when

- **The pages you watch.** Page Watch downloads each watched page from your browser, at the
  interval you chose (plus once when you add a watch, a second time a few seconds later to learn
  which lines change on every visit, and whenever you press *Check now*). Requests are made with
  your browser's cookies for that site, like a normal visit. The HTML is read with `DOMParser`,
  which never runs the page's scripts or loads its images, styles or other resources.
- **The tab you add a watch from.** When you click the toolbar button, Page Watch reads that
  tab's title, address and visible text (to tell whether the page only renders with
  JavaScript). If you pick an element, a small picker script is injected into that tab until you
  save or cancel. This uses Chrome's `activeTab` permission: only the tab you clicked on, only at
  that moment.
- **Files you import.** When you import watches, Page Watch reads the JSON file you choose, in
  the settings page. Nothing from it is sent anywhere.

Page Watch has access to no website by default. When you add a watch, Chrome asks you to allow
access to that one site (for example `https://shop.example.com`). That access is only used to
check the pages you watch there, and it's removed when you delete the last watch for the site.

## What Page Watch stores

Everything is stored with Chrome's extension storage on your device (`chrome.storage.local`, or
`chrome.storage.session` where noted). Nothing is synced by Page Watch or sent anywhere.

| Key | What it holds | How long |
| --- | --- | --- |
| `watches` | Each watch: page address, name, picked element (CSS selector), interval, rule, keyword or target price, paused, sound on/off, status, last error, counts | Until you delete the watch or uninstall |
| `snapshot:<id>` | The latest text of the watched page or element (up to 100,000 characters), the baseline for the next check | Until you delete the watch |
| `changes:<id>` | The last 10 changes of a watch: when, a summary and the changed lines with a little context | Until you delete the watch |
| `noise:<id>` | The noise filter of a watch: the lines (or parts of lines) it learned to ignore, as text | Until you delete the watch, or turn a line back on with *Watch again* |
| `history:<id>` | For number and price watches: the value seen by each check, with its time (up to 500 points) | Until you delete the watch |
| `settings` | Your settings: notifications, sound, default interval, quiet hours | Until you uninstall |
| `plan` | `free` or `pro` (set only by a future payment step; free by default) | Until you uninstall |
| `heldNotifications` | Change and problem notifications held during quiet hours (watch name and summary) | Until the quiet hours end |
| `pendingAdd` (session) | A watch being added while Chrome shows its permission prompt | Up to 5 minutes; gone when the browser closes |
| `checking` (session) | Which watches are being checked right now (for a spinner) | Gone when the check ends or the browser closes |

*Export watches* saves a JSON file with your watches' settings (address, name, selector, rule,
interval, paused, sound) where you choose. It doesn't contain page text, changes or history.

To delete data: delete a watch in the popup (its snapshot, changes, noise filter and history go
with it), remove site access in Settings or in Chrome's extension settings, or uninstall Page
Watch, which deletes everything.

## Network requests

The only network requests Page Watch makes are to the pages you chose to watch, as described
above. It contacts no other host: no Page Watch server, no analytics, no fonts or scripts from a
CDN (fonts and icons are bundled), and no sound files (the optional chime is synthesized in the
browser).

## What Page Watch shares

Nothing. Page Watch doesn't send, sell or share any data, and it contains no third-party code
that could. The websites you watch see a request from your browser each time a page is checked,
as they would for a visit.

## Permissions

- `optional_host_permissions` (`https://*/*`, `http://*/*`), optional: access to one site at a
  time, asked for when you add a watch there, to fetch the pages you watch.
- `storage`: watches, their text, changes, noise filters, value history and settings, as
  described above.
- `alarms`: schedule each watch's checks (and the learning check a few seconds after adding).
- `notifications`: tell you when something changed or a watch stopped working.
- `offscreen`: a hidden extension page that parses fetched HTML (the background service worker
  has no HTML parser) and plays the optional chime.
- `activeTab`, `scripting`: read the current tab and show the element picker, only when you
  click the toolbar button and choose to add a watch.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to provide Page Watch's single
purpose, is never transferred to anyone, and is never used for advertising, credit decisions or
any purpose unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Page Watch is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Page Watch's Chrome Web Store page.
