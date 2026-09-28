# Chrome Web Store listing: Page Watch

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/page-watch-<version>.zip`).

> **Name risk.** "Page Watch" is descriptive and other page monitors use similar wording
> ("PageWatch", "Page Watcher"). Search the store for the exact name before the first upload; if
> it's taken, change `name`, `short_name` and `action.default_title` in `static/manifest.json`,
> then re-run `node scripts/store-assets.mjs` and `npm run package`.

## Name

Page Watch

## Short description (manifest `description`, ≤ 132 characters)

Get notified when a web page, or just the price or part you care about, changes. Timestamps and other noise are filtered out.

## Category and language

Productivity → Tools. Language: English.

## Detailed description

Know when a page changes, without the false alarms.

Page Watch checks the pages you choose in the background and tells you what changed: a price, a
stock label, a job listing, release notes, a government page. You get a notification, a count on
the toolbar icon and a clear before/after.

No false alarms from timestamps and counters
• Most page monitors alert you because "12 people are viewing this" became 15, a timestamp moved
  or the recommendations rotated. Page Watch takes a second look a few seconds after you add a
  page and learns what changes on every visit: counters, times, request ids, rotating
  recommendations, shuffled lists. Those are left out of change detection for that watch.
• Only the changing part of a line is ignored, so a real change on the same line still gets
  through. A new item in a shuffled list still counts.
• You see what's ignored, greyed in the diff and in a list, and one click watches a line again.

Watch just the part you care about
• Click a price, a stock label or a list on the page. Page Watch tells you what it will watch in
  plain words ("Price: $129.00"). Wider/Narrower and the arrow keys adjust the choice.
• Or watch the whole page.

Prices and numbers
• Number and price watches show the value first, where it came from ("$99.00 ↓ from $129.00")
  and a small trend line.
• A chart of every checked value, with the high and low.
• Rules (Pro): a number or price changes, the price drops below a target, it's the lowest in 30
  days, a keyword appears or disappears.

Also
• A clear diff: large before → after for short parts, a line diff for longer ones, the last 10
  changes.
• An optional sound with change notifications, per watch.
• Errors explained with what to do (server errors, a picked element that disappeared, lost site
  access). Failed checks back off politely; at most two pages are fetched at once.
• Quiet hours (Pro): notifications held at night, one summary in the morning.
• Export your watches to a JSON file and import them on another computer.

Good to know
• Checks run only while Chrome is running. Chrome may delay a check slightly.
• Page Watch reads a page's HTML without running its scripts. Pages that only show their content
  after JavaScript runs (many single-page apps and dashboards) can't be watched; Page Watch tells
  you so when you add one instead of saving a watch that would never work.

Private by design: no account, no server, no analytics. Page Watch has access to no website by
default; it asks for one site at a time when you add a watch, and only fetches the pages you
watch there. Everything stays in this browser.

Free vs Pro: 3 watches, checks from every hour, any-change alerts, the noise filter, the element
picker, diffs, sound, export/import and a 7-day price chart are free. Unlimited watches, checks
every 1, 5, 15 or 30 minutes, number/keyword/price rules, "lowest in 30 days", the full price
history and quiet hours are Pro ($3.99 once). During early access, Pro is free for everyone.

## Single purpose

Check web pages (or a part of a page) the user chose, detect when they change, and notify the
user of the change.

## Permission justifications

- **optional host permissions (`https://*/*`, `http://*/*`)**: declared optional; no site is
  accessible by default. When the user adds a watch, Page Watch requests access to that one
  site (e.g. `https://shop.example.com/*`) to fetch the watched page in the background. Access
  is removed when the last watch for the site is deleted.
- **storage**: the user's watches, the latest text of each watched page or element, its last
  changes, its learned noise filter and value history, and settings, in `chrome.storage.local`.
- **alarms**: schedule each watch's next check (and the learning check a few seconds after a
  watch is added, and the end of quiet hours); alarms survive the service worker sleeping.
- **notifications**: tell the user a watched page changed, or that a watch stopped working.
- **offscreen**: a hidden extension document that parses fetched HTML with `DOMParser` (the
  service worker has no DOM) and plays the optional alert chime (reasons `DOM_PARSER` and
  `AUDIO_PLAYBACK`).
- **activeTab**: when the user clicks the toolbar button, read the current tab's title, address
  and visible text to add a watch for it (and detect pages that render only with JavaScript).
- **scripting**: inject the element picker and read the page text in that tab, on demand only.
  No content scripts run on pages otherwise.

## Remote code

No. All code, fonts and icons are in the package. The chime is synthesized with WebAudio.

## Data usage (privacy practices form)

- Page Watch downloads the pages the user chose to watch and keeps their text, changes and
  values locally in `chrome.storage.local`. Nothing is sent to the developer or any third party.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If a reviewer or the form insists that data kept only on the device counts, tick **Website
  content** and say "stored locally only, never transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/page-watch/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The watch list: changes highlighted, a price watch leading with its value and trend |
| `assets/screenshot-2.png` | 1280×800 | The noise filter: ignored lines listed and greyed in the diff, a real price change shown |
| `assets/screenshot-3.png` | 1280×800 | The element picker on a product page: "Price: $129.00" |
| `assets/screenshot-4.png` | 1280×800 | Price history chart and a large before → after (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Dark theme, privacy |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

The screenshots are the e2e test's captures of the real UI on local fixture pages served as
`shop.example.com` and `docs.example.org`. The price chart's earlier weeks are seeded test data
(the test can't wait a month); everything else is produced by real checks.

## Check by hand before submitting

The e2e test covers every flow on local fixture pages; these need a real browser and real sites:

- [ ] Load `release/page-watch-<version>.zip` unpacked (unzip, Load unpacked) in normal Chrome
      120+.
- [ ] Add a whole-page watch on a busy real page (a news homepage, a product page with "people
      viewing" or recommendations). After ~30 seconds, open the watch: check what the noise
      filter learned and that the next hourly checks don't alert on noise alone. **Unverified on
      real sites.**
- [ ] Pick a price element on a real shop (Amazon, a local store) and watch it with "a number or
      price changes"; confirm the value row and chart fill in over a few checks.
- [ ] A signed-in page (e.g. an account page) and a page behind a cookie banner: see what the
      background check gets.
- [ ] Turn on the sound in Settings and trigger a change (e.g. a page you control): the chime
      plays once with the notification.
- [ ] Watch one page every minute for ten minutes and confirm Chrome keeps the pace (packed
      extensions: alarms have a 30-second minimum since Chrome 120).
- [ ] Export, then import the file in a second Chrome profile: permission prompt, merge summary,
      first checks.
- [ ] Take one or two screenshots on real sites if they look better than the fixture ones.

## Notes for the reviewer

Open any product or news page, click the Page Watch toolbar button, then **Watch this page** (or
**Pick an element…** and click a price). Chrome asks for access to that one site; allow it. The
watch appears in the popup; **Check now** runs a check. No account or login is needed. Host
access is optional and per site, requested only when a watch is added.
