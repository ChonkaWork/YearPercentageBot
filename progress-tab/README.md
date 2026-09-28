# Progress Tab

Year, month, week and day progress plus your own countdowns, on every new tab.

The same "year progress" idea as the Telegram bot, in the browser: open a tab and see how much of
2026, this month, this week and today is already gone, and how long is left until the dates you
care about. Calm, local and instant.

![Progress Tab, light theme](screenshots/newtab-1280x800-light.png)

<table>
  <tr>
    <td><img src="screenshots/newtab-1280x800-dark.png" alt="Dark theme"></td>
    <td><img src="screenshots/settings-1280x800-light.png" alt="Settings drawer"></td>
  </tr>
  <tr>
    <td><img src="screenshots/countdown-form-1280x800-light.png" alt="Adding a countdown"></td>
    <td><img src="screenshots/countdown-form-1280x800-dark.png" alt="Adding a countdown, dark"></td>
  </tr>
  <tr>
    <td><img src="screenshots/newtab-800x600-light.png" alt="800×600, light"></td>
    <td><img src="screenshots/settings-800x600-dark.png" alt="800×600 with settings, dark"></td>
  </tr>
  <tr>
    <td><img src="screenshots/life-weeks-1280x800-light.png" alt="Pro: Life in weeks, Paper theme"></td>
    <td><img src="screenshots/life-weeks-1280x800-dark.png" alt="Pro: Life in weeks, Slate theme, dark"></td>
  </tr>
  <tr>
    <td><img src="screenshots/pro-settings-1280x800-light.png" alt="Theme pack and the About Pro card"></td>
    <td><img src="screenshots/countdown-limit-1280x800-light.png" alt="Free plan at its countdown limit"></td>
  </tr>
</table>

All screenshots are in [`screenshots/`](screenshots/) (light and dark, 1280×800 and 800×600). The
e2e test regenerates them at a fixed moment (Friday, October 16, 2026, 09:41 in Europe/Kyiv).

## Features

- **Year, month, week, day.** Percentage elapsed (2 decimals for the year, 1 for the rest; 0–4 in
  settings), a progress bar, "Day 289 of 365" style context and the time left ("76 days 14 h left").
- **Countdowns.** Name + date + optional time. Shows the time left ("6 days 22 h"), "Today" for a
  date without a time, or "passed 6 days ago". Optional progress bar measured from when you added
  it. Nearest first. Add, edit and delete right in the list; delete can be undone.
- **Live.** Updates every second, only touching what changed; stops while the tab is in the
  background.
- **Settings drawer.** Week starts Monday or Sunday, show/hide every block, 12/24-hour time (or
  follow the browser), percent decimals, theme (auto/light/dark) and accent color. Changes apply
  immediately, are saved at once and show up in other open tabs too.
- **Pro (free during early access):** unlimited countdowns, a theme pack (Paper, Slate, Sage, Clay,
  High contrast) and a **Life in weeks** widget. See [Free vs Pro](#free-vs-pro).
- **Correct in your time zone.** DST days are 23 or 25 hours long (the day row says so), leap
  years have 366 days, weeks can span two years, percentages round down so 100% only shows when a
  period is really over.

## How to use

1. **Install.** Build it and load the `dist/` folder as an unpacked extension (see
   [Load the extension in Chrome](#load-the-extension-in-chrome) below).
2. **Open a new tab** (Ctrl+T / ⌘T). Chrome may ask whether to keep the new tab page changed by
   Progress Tab: choose **Keep it**.
3. **Read the rows.** Each row shows how much of the period has passed, a bar, where you are
   ("Day 16 of 31", "Oct 12 – 18") and how long is left. The big clock on top uses your browser's
   12/24-hour convention unless you pick one in settings.
4. **Add a countdown.** Click **Add countdown** (or **+ Add** once you have some). Type a name, pick
   a date, optionally a time, and press **Enter** or click **Add countdown**. Without a time the
   countdown runs to the start of that day. Leave **Show progress since it was added** on to get a
   bar that fills up until the date.
5. **Edit or delete.** Use the pencil and trash icons next to each countdown. In the form, **Enter**
   saves and **Esc** cancels. After a delete, click **Undo** in the message at the bottom (it stays
   while your pointer or keyboard focus is on it).
6. **Change settings.** Click the gear in the top-right corner. Everything applies immediately and
   is saved automatically ("Saved" appears next to the title). Press **Esc** or the × to close.
   - *Show*: switch the clock and date, each row and the countdowns on or off.
   - *Week starts on*: Monday or Sunday.
   - *Time format*: Auto (follow the browser), 12-hour or 24-hour.
   - *Percent decimals*: Auto (2 for the year, 1 for the rest) or a fixed 0–4.
   - *Theme*: Auto (follow the operating system), Light or Dark; with Pro also Paper, Slate, Sage,
     Clay and High contrast (these follow the operating system's light/dark setting). *Accent*: five
     colors.
   - *About Pro* (bottom of the drawer): what Pro adds and its price.
7. **Life in weeks (Pro).** In settings, switch on *Show → Life in weeks*. The new card explains that
   your birth date stays in this browser, then asks for it and an expected span (80 years unless you
   change it, 20–120). Click **Show my weeks**: one column per year of your life, one square per
   week, lived weeks in the accent color and this week marked, with the percentage of the span and a
   sentence like "1,902 weeks lived, about 2,272 left of 80 years". The pencil changes the date or
   span; **Forget birth date** removes it from storage.
8. **Keyboard.** Everything works without a mouse: Tab reaches the gear, **+ Add** and every
   countdown's Edit/Delete; date and time fields take typed digits; Esc closes the form or drawer.

Your data never leaves the browser. To start over, remove the extension in `chrome://extensions`
(this deletes its storage).

## Free vs Pro

| Free | Pro ($1.99 once) |
| ---- | ---------------- |
| Year, month, week and day rows, clock, every setting | Everything in Free |
| Up to 3 countdowns | Unlimited countdowns (a safety cap of 200) |
| 2 themes: Light and Dark (Auto switches between them) | Theme pack: Paper, Slate, Sage, Clay, High contrast, each in light and dark |
| | **Life in weeks** widget |

- **Early access:** payments aren't set up yet, so everyone gets Pro for now. The settings drawer
  ends with an **About Pro** card listing the Pro features and the price; its **Get Pro** button is
  disabled and says "Free during early access". Pro items carry a small `PRO` badge.
- **When early access ends,** a free user who already has more than 3 countdowns keeps all of them
  and can still edit and delete them (and undo a delete); only **adding** is blocked, with a calm
  note in the countdown card ("Free keeps 3 countdowns. Pro removes the limit.") and a link to About
  Pro. A Pro theme or Life in weeks chosen earlier falls back to Auto / hidden without being erased,
  so it comes back with Pro. Nothing is ever deleted because of the plan.
- **How it's built:** `src/core/plan.ts` (pure, unit-tested) holds `EARLY_ACCESS = true`,
  `PRO_PRICE`, `hasFeature`, `limitsFor` and `isEntitled`; every check goes through it. The plan is
  read from `chrome.storage.local` (`plan`, sanitized, default `free`). There is no payment code:
  a future adapter would only write `plan: 'pro'`. Theme and widget registries mark Pro entries with
  `tier: 'pro'` and the feature they belong to. See `docs/MONETIZATION.md` at the repo root.

## Privacy

Everything runs locally. Progress Tab has no backend, no account, no analytics, no remote fonts or
scripts, and makes no network requests (the page's Content Security Policy doesn't allow any:
`default-src 'none'`). Settings, countdowns and the plan are stored in `chrome.storage.local` in
this browser only; a copy of the settings and the plan is kept in the page's `localStorage` so a new
tab can apply your theme before it first paints.

**Birth date (Life in weeks).** Only asked for when you turn the widget on, stored with the settings
(`chrome.storage.local` and the `localStorage` copy) in this browser, used only to draw the grid,
never sent anywhere. **Forget birth date** removes it from both.

### Permissions

| Permission | Why |
| ---------- | --- |
| `storage`  | Save settings (including the optional birth date), countdowns and the plan in `chrome.storage.local`. |

That's all. Replacing the new tab page (`chrome_url_overrides.newtab`) needs no permission. There
is no toolbar button, background script or content script, and no access to any website.

## How the numbers are computed

- Everything is in the browser's **local time zone**. Period boundaries are built from calendar
  dates (`new Date(y, m, d)`), never by adding 24 hours, so a DST day is 23 or 25 hours long (23.5
  or 24.5 on Lord Howe Island) and the day row says "25-hour day, clocks go back". Where midnight
  doesn't exist (e.g. Chile on DST day) the day starts at 01:00.
- **Progress** is real elapsed time: `(now − start) / (end − start)`, **rounded down**, so the last
  second of the year reads 99.99% and 100% appears only when it's over. At exactly midnight the
  new period starts at 0%.
- **Time left** counts whole calendar days first, then real hours and minutes: "12 days" means the
  same wall-clock time 12 dates later, even across a DST change. From one hour up it's rounded up to
  the minute, so it agrees with the clock (at 12:01 the day has "11 h 59 min left"); under an hour
  it shows seconds.
- **Life in weeks** draws 52 squares per year of age (the classic poster); a new column starts on
  each birthday, so the 52nd square also holds the last day or two of that year (Feb 29 birthdays
  count from Mar 1 in other years). The percentage is real elapsed time from the birth date to the
  same date `span` years later, rounded down; "weeks lived" and "about … left" are real 7-day weeks.
- **Countdown dates** are local dates. A time that doesn't exist because of DST resolves to the
  moment after the gap; a time that happens twice (clocks go back) means the first one. Invalid
  dates (Feb 30) can't be saved.

## Development

Requires Node.js 22.12+ (vitest 5).

```bash
npm install
npm run build        # production build -> dist/
npm run dev          # rebuild on change (with source maps) -> dist/
npm run typecheck
npm test             # unit tests (vitest), including every time zone below
npm run check        # typecheck + unit tests + build
npm run test:e2e     # builds dist/ and dist-e2e/, drives dist-e2e/ in real Chromium
```

`test:e2e` needs a Chromium build. It's auto-detected in some environments; otherwise set
`CHROMIUM_PATH=/path/to/chromium`. `HEADED=1` shows the browser. It runs in Europe/Kyiv with an
en-GB locale (`E2E_TZ=America/New_York` to change the zone). The e2e build can switch early access off (a
`localStorage` flag compiled out of `dist/`) to test the free plan and its limits. Screenshots go to `e2e/output/`
(git-ignored); the curated ones are also copied to `screenshots/`, which is committed.

### Time zone tests

Date math depends on the local time zone, so `test/zones/` runs once per zone as separate vitest
projects (see `vitest.config.ts`), each with its own `TZ`:

| Zone | Why |
| ---- | --- |
| `UTC` | No DST: exact textbook values |
| `Europe/Kyiv` | 23 h day in March, 25 h day in October (changes at 03:00/04:00) |
| `America/New_York` | DST at 02:00 on different dates than Europe |
| `America/Santiago` | DST starts at midnight, so that day begins at 01:00 |
| `Australia/Lord_Howe` | 30-minute DST shift |
| `Asia/Kolkata` | +05:30, no DST |

Every project first asserts that its zone really applied. Zone-specific expectations are checked
against absolute UTC instants and only run in their zone; the rest (contiguous days, weeks and
months over whole years, monotonic progress, remaining time adding up exactly) runs in all of them.

```bash
npx vitest run --project tz:Europe/Kyiv    # one zone
TEST_TZ=Asia/Tokyo npm test                # add any zone for one run
```

The zone-independent tests (`test/*.test.ts`) run once, pinned to UTC.

### Load the extension in Chrome

1. `npm install`
2. `npm run build`
3. Open `chrome://extensions`
4. Turn on **Developer mode** (top right)
5. Click **Load unpacked**
6. Select the `dist/` directory

After a rebuild, press the reload icon on the Progress Tab card in `chrome://extensions` and open a
new tab.

### Packaging for the Chrome Web Store

`dist/` is the complete extension: no source maps, no test code, unminified identifiers so review
is easy (about 305 KB including the fonts). Zip the *contents* of `dist/` and upload that.

### Icons

`static/icons/icon.svg` is the source; the PNGs are rendered from it and committed. After changing
the SVG: `node scripts/make-icons.mjs` (uses `CHROMIUM_PATH` or the auto-detected Chromium).

## Project structure

```
src/
  core/         Pure logic, no DOM or Chrome APIs, all tested:
                  time.ts       period boundaries, calendar differences (local time, DST-safe)
                  periods.ts    what each row shows (labels, captions, time left)
                  countdown.ts  countdown model: parsing, validation, state, sorting, sanitizing
                  format.ts     English formatting (percent, durations, dates, 12/24 h)
                  settings.ts   settings model, sanitizeSettings, applyEntitlements
                  plan.ts       Free vs Pro: EARLY_ACCESS, hasFeature, limitsFor, isEntitled
                  life.ts       Life in weeks: validation and the grid/summary model
                  themes.ts     theme and accent registry (+ contrast math)
                  widgets.ts    widget registry (what can be shown/hidden)
  storage/      chrome.storage wrappers (+ the localStorage paint-time copy of the settings)
  newtab/       The page: progress rows, countdowns, life in weeks (canvas), settings drawer,
                About Pro card, toast, ticker, theming
  ui/           DOM helpers and Bootstrap Icons
  styles/       Bootstrap 5.3 Sass build with the Progress Tab theme
static/         manifest.json, newtab.html, icons
test/           Unit tests (test/zones/ runs once per time zone)
e2e/            Chromium smoke test
screenshots/    Curated screenshots used in this README
```

The page is vanilla TypeScript bundled by esbuild (one IIFE, `chrome116`). Styles are Bootstrap
5.3 compiled from Sass with only the parts used (see `docs/design-system.md` at the repo root),
Bootstrap Icons inlined as SVG, and the Manrope and JetBrains Mono variable fonts bundled
(Latin, Latin Extended and Cyrillic).

### Rendering and performance

The script runs from `<head>`: it applies the cached theme before the first paint, renders all rows
synchronously on `DOMContentLoaded` from the cached (or default) settings, then reads
`chrome.storage.local` once and applies any difference. The e2e test checks the rows exist before
the first contentful paint (typically rendered ~40 ms after navigation start, headless). The ticker
aligns to whole seconds, writes only changed text/attributes, moves bars with `transform`, and
stops while the tab is hidden. Life in weeks is one `<canvas>` (about 4,000 squares in three
batched paths), redrawn only when the week, the settings, the theme or the card width changes.

### Adding a theme, accent or widget

Themes, accents and widgets are data: the settings drawer is built from `THEMES`, `ACCENTS`
(`src/core/themes.ts`) and `WIDGETS` (`src/core/widgets.ts`), and `sanitizeSettings` accepts
exactly the ids listed there.

- **Accent:** add an entry with light and dark palettes. A unit test checks every palette for
  WCAG contrast (text 4.5:1, bars 3:1) in both schemes.
- **Theme:** add an entry with a `scheme` and optional `tokens` (CSS custom properties such as
  `--pt-page-bg`, `--pt-surface`, `--bs-body-color`, `--bs-secondary-color`) per scheme. Unit tests
  check every accent against the theme's backgrounds, and body/secondary text of the theme pack, in
  both schemes.
- **Widget:** add an entry to `WIDGETS` and render it in `src/newtab/`.

Every entry has a `tier`: `'free'`, or `'pro'` with the `feature` from `plan.ts` it belongs to. The
settings drawer badges and (without the feature) disables Pro entries, and `applyEntitlements`
decides what the page shows.

## Known limitations

- Chrome decides whether an extension may replace the new tab page; on first use it asks the user
  to keep the change. Incognito windows keep Chrome's own new tab page.
- The format of the date and time fields (dd/mm/yyyy vs mm/dd/yyyy, 12/24 h) follows Chrome's UI
  language, not the Progress Tab time format setting.
- Countdowns use the time zone the browser is in right now. If you travel, a countdown to "Dec 31,
  20:00" means 20:00 wherever you are, not in the zone where you created it.
- Years before 1000 or after 9999 aren't accepted for countdowns. Free keeps 3 countdowns (once early
  access ends); Pro has a safety cap of 200.
- Pro themes follow the operating system's light/dark setting; only the free Light and Dark themes
  can force a scheme.
- Life in weeks accepts birth dates from 1900 and a span of 20–120 years. Long spans in narrow windows
  draw smaller squares (down to 3 px).
- Payments aren't implemented: during early access everyone has Pro, and "Get Pro" is disabled.
- The UI is English only.
