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

Year, month, week and day progress plus your own countdowns on every new tab.

## Category and language

Productivity → Workflow & Planning (alternative: Productivity → Tools). Language: English.

## Detailed description

How much of the year is already gone? Every new tab tells you.

Progress Tab replaces Chrome's new tab page with a calm view of time: the year, the month, the
week and today as progress bars with exact percentages, and countdowns to the things you are
waiting for.

At a glance
• 2026 is 79.00% done, day 289 of 365, 76 days left. The same for this month, this week and
  today, updated every second.
• A big clock and today's date.
• Choose which rows to show, when your week starts, 12- or 24-hour time and how many decimals.

Countdowns
• Trips, birthdays, deadlines, launches: days and hours left, "Today" when it's here, and
  "passed 6 days ago" afterwards.
• Optionally show how far along you are since you added it.
• Add, edit and remove right on the new tab page. Enter saves, Esc cancels.

Life in weeks (Pro)
• Your life as a grid of weeks, one column per year. A quiet reminder to spend them well.
• Your birth date is only asked for when you turn it on and never leaves your browser. One click
  forgets it.

Themes
• Free: Auto, Light and Dark, with five accent colors (Mint, Blue, Orange, Pink, Graphite).
• Theme pack (Pro): Paper, Slate, Sage, Clay and High contrast, each in light and dark.

Private by design: no account, no ads, no analytics, no network requests. The page doesn't load
anything from the internet (its security policy forbids it). Settings and countdowns stay in this
browser.

Free vs Pro: progress bars, the clock, the Light and Dark themes and 3 countdowns are free.
Unlimited countdowns, Life in weeks and the theme pack are Pro ($1.99 once). During early access,
Pro is free for everyone.

## Single purpose

Replace the new tab page with the progress of the current year, month, week and day and the
user's own countdowns.

## Permission justifications

- **storage**: save the user's settings (including the optional birth date for Life in weeks)
  and countdowns in `chrome.storage.local`.
- **New tab override** (`chrome_url_overrides.newtab`, not a permission): the whole product is
  the new tab page.

No host permissions, no content scripts, no background script.

## Remote code

No. All code, fonts and icons are in the package; the page's Content Security Policy is
`default-src 'none'` with only `'self'` for scripts, styles and fonts.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Settings, countdowns and the optional
  birth date are kept in `chrome.storage.local` (and a `localStorage` copy of the settings for
  instant theming).
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
| `assets/screenshot-1.png` | 1280×800 | The new tab: year, month, week, today and countdowns |
| `assets/screenshot-2.png` | 1280×800 | Adding a countdown |
| `assets/screenshot-3.png` | 1280×800 | Life in weeks (Pro) |
| `assets/screenshot-4.png` | 1280×800 | Theme pack in settings (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Dark theme |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

The raw 1280×800 captures in `../screenshots/` (`*-1280x800-*.png`) can be uploaded instead if
you prefer full-bleed screenshots without captions.

## Check by hand before submitting

Progress Tab touches no website, so the e2e run covers almost everything. Still:

- [ ] Load `release/progress-tab-<version>.zip` unpacked in normal Chrome, open a new tab, and
      keep the change when Chrome asks "Change back to Google?".
- [ ] Add a countdown, reload, restart Chrome: it's still there.
- [ ] Turn on Life in weeks, then Forget birth date: the widget asks again.
- [ ] Check it on a laptop screen (1366×768) and a large monitor.

## Notes for the reviewer

Install and open a new tab: that page is the whole product. "+ Add" creates a countdown; Settings
is the gear in the top-right corner. No account or login is needed.
