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
   - *Theme*: Auto (follow the operating system), Light or Dark. *Accent*: five colors.
7. **Keyboard.** Everything works without a mouse: Tab reaches the gear, **+ Add** and every
   countdown's Edit/Delete; date and time fields take typed digits; Esc closes the form or drawer.

Your data never leaves the browser. To start over, remove the extension in `chrome://extensions`
(this deletes its storage).

## Privacy

Everything runs locally. Progress Tab has no backend, no account, no analytics, no remote fonts or
scripts, and makes no network requests (the page's Content Security Policy doesn't allow any:
`default-src 'none'`). Settings and countdowns are stored in `chrome.storage.local` in this browser
only; a copy of the settings is kept in the page's `localStorage` so a new tab can apply your theme
before it first paints.

### Permissions

| Permission | Why |
| ---------- | --- |
| `storage`  | Save settings and countdowns in `chrome.storage.local`. |

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
en-GB locale (`E2E_TZ=America/New_York` to change the zone). Screenshots go to `e2e/output/`
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
is easy (about 270 KB including the fonts). Zip the *contents* of `dist/` and upload that.

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
                  settings.ts   settings model and sanitizeSettings
                  themes.ts     theme and accent registry (+ contrast math)
                  widgets.ts    widget registry (what can be shown/hidden)
  storage/      chrome.storage wrappers (+ the localStorage paint-time copy of the settings)
  newtab/       The page: progress rows, countdowns, settings drawer, toast, ticker, theming
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
stops while the tab is hidden.

### Adding a theme, accent or widget

Themes, accents and widgets are data: the settings drawer is built from `THEMES`, `ACCENTS`
(`src/core/themes.ts`) and `WIDGETS` (`src/core/widgets.ts`), and `sanitizeSettings` accepts
exactly the ids listed there.

- **Accent:** add an entry with light and dark palettes. A unit test checks every palette for
  WCAG contrast (text 4.5:1, bars 3:1) in both schemes.
- **Theme:** add an entry with a `scheme` and optional `tokens` (CSS custom properties such as
  `--pt-page-bg`, `--pt-surface`) per scheme.
- **Widget:** add an entry to `WIDGETS` and render it in `src/newtab/`.

Every entry has a `tier` (`'free'` today). Paid themes or widgets would add another tier and
filter by entitlement; there is deliberately no payment code.

## Known limitations

- Chrome decides whether an extension may replace the new tab page; on first use it asks the user
  to keep the change. Incognito windows keep Chrome's own new tab page.
- The format of the date and time fields (dd/mm/yyyy vs mm/dd/yyyy, 12/24 h) follows Chrome's UI
  language, not the Progress Tab time format setting.
- Countdowns use the time zone the browser is in right now. If you travel, a countdown to "Dec 31,
  20:00" means 20:00 wherever you are, not in the zone where you created it.
- Years before 1000 or after 9999 aren't accepted for countdowns. At most 50 countdowns.
- The UI is English only.
