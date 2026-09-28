# Chrome Web Store listing: Progress Tab

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/progress-tab-<version>.zip`).

Name check (September 2026): no Chrome Web Store item called "Progress Tab" turned up. Similar
products exist under other names ("Year Progress", "Year Progress Bar", "Year Dot Calendar"), so
the listing competes on screenshots and reviews, not on the name.

## Name

Progress Tab

## Short description (manifest `description`, ≤ 132 characters)

Year, month, week and day progress, goals paced against the year, quick links and countdowns on every new tab.

## Category and language

Productivity → Workflow & Planning (alternative: Productivity → Tools). Language: English.

## Detailed description

How much of the year is already gone, and are your goals keeping up? Every new tab tells you.

Progress Tab replaces Chrome's new tab page with a calm view of time: the year in big type with a
20-block bar, the month, the week and today, your goals paced against the calendar, the sites you
open every day, and countdowns to the things you are waiting for.

At a glance
• 2026 is 79.00% done: day 289 of 365, 76 days left. The same for this month, this week and
  today, updated every second.
• A big clock and today's date, with your quick links right under it.
• Choose which blocks to show, when your week starts, 12- or 24-hour time and how many decimals.

Goals, paced against the year
• "Read 24 books", "Run 1,000 km": tap +1 as you go.
• The bar shows your count, a marker shows where the year is, and a plain verdict tells you where
  you stand: "17 of 24 · 2 books behind pace", "on pace", "3 books ahead", "goal reached".
• For this year, this quarter, this month or your own dates.

Share the year
• One click makes an image: "2026 is 79.00% complete" with a ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ bar, in your
  theme. Also for this month or a countdown.
• Download it as a PNG or copy it and paste it into any chat. Made on your computer; nothing is
  uploaded.

Quick links
• Your everyday sites as tiles under the clock, with a letter in your accent color.
• Add, rename, reorder and remove them right there.

Countdowns
• Trips, birthdays, deadlines, launches: days and hours left ("6 d 22 h"), "Today" when it's
  here.
• Birthdays and rent repeat by themselves: every year or every month, always counting to the next
  date.
• Past dates tuck away in a "Past" group. Optionally show how far along you are.

Life in weeks (Pro)
• Your life as a grid of weeks, one column per year. A quiet reminder to spend them well.
• Your birth date is only asked for when you turn it on and never leaves your browser. One click
  forgets it.

Themes
• Free: Auto, Light and Dark, with five accent colors (Mint, Blue, Orange, Pink, Graphite).
• Theme pack (Pro): Paper, Slate, Sage, Clay and High contrast, each in light and dark.

Private by design: no account, no ads, no analytics, no network requests. The page doesn't load
anything from the internet (its security policy forbids it) and never contacts your quick links'
sites. Settings, goals, links and countdowns stay in this browser.

Free vs Pro: the progress rows, the clock, the share card, repeating countdowns, the Light and Dark
themes, 1 goal, 6 quick links and 3 countdowns are free. Unlimited goals, quick links and
countdowns, Life in weeks (also as a share card) and the theme pack are Pro ($1.99 once). During
early access, Pro is free for everyone.

## Single purpose

Replace the new tab page with the progress of the current year, month, week and day and the
user's own countdowns.

## Permission justifications

- **storage**: save the user's settings (including the optional birth date for Life in weeks),
  countdowns, goals and quick links in `chrome.storage.local`.
- **New tab override** (`chrome_url_overrides.newtab`, not a permission): the whole product is
  the new tab page.

No host permissions, no content scripts, no background script. The share image is downloaded
through a plain download link and copied with the asynchronous clipboard API from the user's click,
so neither `downloads` nor `clipboardWrite` is requested.

## Remote code

No. All code, fonts and icons are in the package; the page's Content Security Policy is
`default-src 'none'` with only `'self'` for scripts, styles and fonts.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Settings, countdowns, goals, quick links
  and the optional birth date are kept in `chrome.storage.local` (and a `localStorage` copy of the
  settings for instant theming). Quick links are only opened when the user clicks them (no
  favicons or previews are fetched); share images are made locally and only downloaded or copied
  on the user's click.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If the form insists that data kept only on the device counts, the birth date is
  **Personally identifiable information** (stored locally only, never transmitted).

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/progress-tab/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The new tab: the year as the hero, month/week/day, goals against the year, quick links, countdowns |
| `assets/screenshot-2.png` | 1280×800 | Share card: the dialog and the image it makes ("2026 is 79.00% complete") |
| `assets/screenshot-3.png` | 1280×800 | Countdowns that repeat (birthday, rent), the Past group, adding one |
| `assets/screenshot-4.png` | 1280×800 | Life in weeks and the theme pack (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Dark theme, private by design |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

The raw captures in `../screenshots/` (`*-1280x800-*.png`) can be uploaded instead if you prefer
full-bleed screenshots without captions.

## Check by hand before submitting

Progress Tab touches no website, so the e2e run covers almost everything. Still:

- [ ] Load `release/progress-tab-<version>.zip` unpacked in normal Chrome, open a new tab, and
      keep the change when Chrome asks "Change back to Google?".
- [ ] Add a countdown, reload, restart Chrome: it's still there.
- [ ] Turn on Life in weeks, then Forget birth date: the widget asks again.
- [ ] Add a goal and press +1 a few times; reload: the count is kept.
- [ ] Share → Copy image, then paste into a real chat app (Telegram, Slack) and a document; Share →
      Download PNG and open the file. Copy was verified in headless Chromium 141 only
      (**unverified** in stable Chrome on Windows/macOS).
- [ ] Add a quick link to a real site and click it: the site opens in the same tab.
- [ ] Check it on a laptop screen (1366×768) and a large monitor.

## Notes for the reviewer

Install and open a new tab: that page is the whole product. "Add link" (under the clock) adds a
quick link, "Add goal" a goal, "+ Add" a countdown, "Share" (next to the year) makes a share image;
Settings is the gear in the top-right corner. No account or login is needed.
