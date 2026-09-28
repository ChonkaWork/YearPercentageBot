# Progress Tab

Year, month, week and day progress, goals paced against the year, quick links and your own
countdowns, on every new tab.

The same "year progress" idea as the Telegram bot, in the browser: open a tab and see how much of
2026, this month, this week and today is already gone, whether your goals for the year are on
pace, and how long is left until the dates you care about. Share the year as an image with the
bot's ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ bar. Calm, local and instant.

![Progress Tab, light theme](screenshots/newtab-1280x800-light.png)

<table>
  <tr>
    <td><img src="screenshots/newtab-1280x800-dark.png" alt="Dark theme"></td>
    <td><img src="screenshots/share-1280x800-light.png" alt="Share card dialog"></td>
  </tr>
  <tr>
    <td><img src="screenshots/share-card-year.png" alt="The shared image: 2026 is 79.00% complete"></td>
    <td><img src="screenshots/share-1280x800-dark.png" alt="Share card, dark theme"></td>
  </tr>
  <tr>
    <td><img src="screenshots/goal-form-light.png" alt="Adding a goal with its own dates"></td>
    <td><img src="screenshots/links-edit-1280x800-light.png" alt="Editing and reordering a quick link"></td>
  </tr>
  <tr>
    <td><img src="screenshots/countdowns-past-dark.png" alt="Repeating countdowns, row actions on hover, the Past group opened"></td>
    <td><img src="screenshots/settings-1280x800-light.png" alt="Settings drawer"></td>
  </tr>
  <tr>
    <td><img src="screenshots/countdown-form-1280x800-light.png" alt="Adding a countdown that repeats every year"></td>
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
    <td><img src="screenshots/goals-limit-free-light.png" alt="Free plan: three goals kept, adding a fourth explains the limit"></td>
  </tr>
  <tr>
    <td><img src="screenshots/countdown-limit-1280x800-light.png" alt="Free plan at its countdown limit, with the empty states of goals and quick links"></td>
    <td></td>
  </tr>
</table>

All screenshots are in [`screenshots/`](screenshots/) (light and dark, 1280×800 and 800×600; the
`*-light.png` / `*-dark.png` ones without a size are full-page captures of longer states). The e2e
test regenerates them at a fixed moment (Friday, October 16, 2026, 09:41 in Europe/Kyiv; the free
plan one at Sunday, September 27, 12:00).

## Features

- **The year first.** A big "79.00% of 2026" with a thick 20-segment bar (the ▓░ bar of the
  Telegram bot, still one accessible progress bar), "Day 289 of 365" and the time left. Month,
  week and day follow as compact rows. Percentages: 2 decimals for the year, 1 for the rest (0–4
  in settings), rounded down.
- **Goals paced against the year** (Free: 1 goal, Pro: any number). "Read 24 books": a count you
  move with **+1 / −1**, a bar with the year's position marked on it, and a plain verdict:
  "17 of 24 · 2 books behind pace", "on pace", "3 books ahead", "goal reached". Pace is target ×
  share of the goal's period gone; the period is this year by default, or this quarter, this month
  or your own dates.
- **Share card** (Free). "Share" next to the year makes a 1200×630 image in your theme: "2026 is
  79.00% complete", 20 blocks like the bot, the date and a small Progress Tab wordmark. Also for
  this month, a countdown, or Life in weeks (Pro). **Download PNG**, or **Copy image** and paste it
  into a chat. Made on the page; nothing is uploaded.
- **Quick links** (Free: 6, Pro: any number). Name + web address tiles under the clock with a letter
  in the accent color (no favicons, so no permission and no request to the site). Add, edit,
  reorder, delete (with undo). Only http and https addresses.
- **Countdowns.** Name + date + optional time. Shows the time left ("6 d 22 h", units small and
  muted), "Today" for a date without a time, or "passed 6 days ago". **Repeats every year or every
  month** (birthdays, rent): after the date it moves on to the next one (Feb 29 is Feb 28 in other
  years; a monthly 31st is the last day of shorter months). Optional progress bar, measured from
  when you added it (or from the previous date, once it repeats). Nearest first; passed ones wait
  in a **Past** group, collapsed. Edit and delete appear on hover or keyboard focus; delete can be
  undone.
- **Live.** Updates every second, only touching what changed; stops while the tab is in the
  background.
- **Settings drawer.** Week starts Monday or Sunday, show/hide every block, 12/24-hour time (or
  follow the browser), percent decimals, theme (auto/light/dark) and accent color. Changes apply
  immediately, are saved at once and show up in other open tabs too.
- **Pro (free during early access):** unlimited goals, countdowns and quick links, a theme pack
  (Paper, Slate, Sage, Clay, High contrast) and a **Life in weeks** widget (also as a share card).
  See [Free vs Pro](#free-vs-pro).
- **Correct in your time zone.** DST days are 23 or 25 hours long (the day row says so), leap
  years have 366 days, weeks can span two years, percentages round down so 100% only shows when a
  period is really over.

## How to use

1. **Install.** Build it and load the `dist/` folder as an unpacked extension (see
   [Load the extension in Chrome](#load-the-extension-in-chrome) below).
2. **Open a new tab** (Ctrl+T / ⌘T). Chrome may ask whether to keep the new tab page changed by
   Progress Tab: choose **Keep it**.
3. **Read the rows.** The year is on top in large type ("79.00% of 2026") with its 20-segment bar,
   the day of the year and the time left. Month, week and today follow as compact rows: where you
   are ("Day 16 of 31", "Oct 12 – 18"), a bar, the percentage and the time left ("15 d 14 h
   left"). The big clock uses your browser's 12/24-hour convention unless you pick one in settings.
4. **Add quick links.** Click **Add link** under the clock, type a web address (`github.com` is
   enough; `https://` is added) and, if you like, a name, then **Enter**. Only http and https
   addresses are accepted. A click opens the site in this tab (middle-click: a new tab). To change
   one, point at it (or Tab to it) and click the pencil: edit, **←** / **→** to move it, or
   **Delete** (with Undo).
5. **Set a goal.** In the Goals card click **Add goal**. Name it ("Read 24 books"), set the target,
   optionally a unit ("books") and what you've done so far, and pick the period: **This year**
   (default), **This quarter**, **This month** or **Dates** (your own first and last day). The bar
   shows your count; the dark tick on it is where the period is, so the bar should reach the tick
   to be on pace. Click **+1** (or **−1**) as you go; the verdict below updates and is announced to
   screen readers. Pencil and trash (on hover or focus) edit or delete a goal.
6. **Share the year.** Click **Share** next to the year. Pick **Year**, **Month**, **Life in weeks**
   (Pro, once your birth date is set) or **Countdown** (then choose which one), check the preview,
   and click **Download PNG** (saved to your downloads as `progress-tab-2026.png`) or **Copy image**
   and paste it into a chat or post. **Esc** closes.
7. **Add a countdown.** Click **Add countdown** (or **+ Add** once you have some). Type a name, pick
   a date, optionally a time, and press **Enter** or click **Add countdown**. Without a time the
   countdown runs to the start of that day. **Repeats**: *Every year* for birthdays (enter the
   birth date, it counts to the next one), *Every month* for rent or payday. Leave **Show progress
   since it was added** on to get a bar that fills up until the date.
8. **Edit or delete a countdown.** Point at a countdown (or Tab to it): pencil and trash appear. In
   the form, **Enter** saves and **Esc** cancels. After a delete, click **Undo** in the message at
   the bottom (it stays while your pointer or keyboard focus is on it). Countdowns whose date has
   passed move under **Past** at the bottom of the card; click it to open or close the group.
9. **Change settings.** Click the gear in the top-right corner. Everything applies immediately and
   is saved automatically ("Saved" appears next to the title). Press **Esc** or the × to close.
   - *Show*: switch the clock and date, quick links, each row, goals and countdowns on or off.
   - *Week starts on*: Monday or Sunday.
   - *Time format*: Auto (follow the browser), 12-hour or 24-hour.
   - *Percent decimals*: Auto (2 for the year, 1 for the rest) or a fixed 0–4.
   - *Theme*: Auto (follow the operating system), Light or Dark; with Pro also Paper, Slate, Sage,
     Clay and High contrast (these follow the operating system's light/dark setting). *Accent*: five
     colors.
   - *About Pro* (bottom of the drawer): what Pro adds and its price.
10. **Life in weeks (Pro).** In settings, switch on *Show → Life in weeks*. The new card explains that
   your birth date stays in this browser, then asks for it and an expected span (80 years unless you
   change it, 20–120). Click **Show my weeks**: one column per year of your life, one square per
   week, lived weeks in the accent color and this week marked, with the percentage of the span and a
   sentence like "1,902 weeks lived, about 2,272 left of 80 years". The pencil changes the date or
   span; **Forget birth date** removes it from storage.
11. **Keyboard.** Everything works without a mouse: Tab reaches the gear, every quick link and its
   pencil, **Add link**, **Share**, the goals' +1/−1 and every Edit/Delete (they show while
   focused); date and time fields take typed digits; Esc closes a form, the share dialog or the
   drawer.

Your data never leaves the browser. To start over, remove the extension in `chrome://extensions`
(this deletes its storage).

## Free vs Pro

| Free | Pro ($1.99 once) |
| ---- | ---------------- |
| Year, month, week and day rows, clock, every setting | Everything in Free |
| Share card: year, month, a countdown (Download PNG, Copy image) | Share card for Life in weeks too |
| Repeating countdowns (every year / every month) | |
| 1 goal paced against the year | **Unlimited goals** (a safety cap of 100) |
| Up to 6 quick links | **Unlimited quick links** (a safety cap of 100) |
| Up to 3 countdowns | **Unlimited countdowns** (a safety cap of 200) |
| 2 themes: Light and Dark (Auto switches between them) | Theme pack: Paper, Slate, Sage, Clay, High contrast, each in light and dark |
| | **Life in weeks** widget |

- **Early access:** payments aren't set up yet, so everyone gets Pro for now. The settings drawer
  ends with an **About Pro** card listing the Pro features and the price; its **Get Pro** button is
  disabled and says "Free during early access". Pro items carry a small `PRO` badge.
- **When early access ends,** a free user who already has more than 3 countdowns, 1 goal or 6 quick
  links keeps all of them and can still use, edit and delete them (and undo a delete; +1 still
  works on every goal); only **adding** is blocked, with a calm note in the card ("Free keeps 3
  countdowns. Pro removes the limit.", "Free tracks 1 goal. Pro removes the limit.", "Free keeps 6
  quick links. Pro removes the limit.") and a link to About Pro. A Pro theme or Life in weeks chosen
  earlier falls back to Auto / hidden without being erased, so it comes back with Pro; the share
  dialog shows Life in weeks disabled with the same About Pro link. Nothing is ever deleted
  because of the plan.
- **How it's built:** `src/core/plan.ts` (pure, unit-tested) holds `EARLY_ACCESS = true`,
  `PRO_PRICE`, `hasFeature`, `limitsFor` (`maxCountdowns`, `maxGoals`, `maxLinks`), `listLimit`,
  `limitMessage` and `isEntitled`; every check goes through it. The plan is
  read from `chrome.storage.local` (`plan`, sanitized, default `free`). There is no payment code:
  a future adapter would only write `plan: 'pro'`. Theme and widget registries mark Pro entries with
  `tier: 'pro'` and the feature they belong to. See `docs/MONETIZATION.md` at the repo root.

## Privacy

Everything runs locally. Progress Tab has no backend, no account, no analytics, no remote fonts or
scripts, and makes no network requests (the page's Content Security Policy doesn't allow any:
`default-src 'none'`). Settings, countdowns, goals, quick links and the plan are stored in
`chrome.storage.local` in this browser only; a copy of the settings and the plan is kept in the
page's `localStorage` so a new tab can apply your theme before it first paints.

**Quick links** are only addresses you typed. Nothing is fetched from them (no favicons, no
previews); clicking one simply opens that site, like any link, and the site isn't told it came from
Progress Tab (`rel="noreferrer"`).

**Share card.** The image is drawn on a `<canvas>` in the page. **Download PNG** is an ordinary
download link to that image (a `blob:` address that exists only in this tab); **Copy image**
puts it on your clipboard. Nothing is uploaded; where the image goes next is up to you. The card
never shows your birth date (Life in weeks shows the percentage and weeks only).

**Birth date (Life in weeks).** Only asked for when you turn the widget on, stored with the settings
(`chrome.storage.local` and the `localStorage` copy) in this browser, used only to draw the grid,
never sent anywhere. **Forget birth date** removes it from both.

Full privacy policy: [`PRIVACY.md`](PRIVACY.md).

### Permissions

| Permission | Why |
| ---------- | --- |
| `storage`  | Save settings (including the optional birth date), countdowns, goals, quick links and the plan in `chrome.storage.local`. |

That's all. Replacing the new tab page (`chrome_url_overrides.newtab`) needs no permission. There
is no toolbar button, background script or content script, and no access to any website.

- **No `clipboardWrite`.** Copy image uses the asynchronous clipboard API from the click itself,
  which an extension page may do without that permission. The e2e test checks this in Chromium 141
  by really pasting the image (a 1200×630 PNG comes out); if a browser refuses, the dialog says so
  and Download PNG still works. Where the API is missing, Copy image is hidden.
- **No `downloads`.** Download PNG is a plain `<a download>` link.
- **No CSP change.** The page's policy is still `default-src 'none'` with `img-src 'self' data:`.
  The preview is the canvas itself (not an `<img>` of the PNG), and a download link to a `blob:`
  address is a navigation, not an image load, so `blob:` did not have to be allowed anywhere (the
  e2e test asserts the exact policy and that the download works).

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
- **Repeating countdowns** keep the stored date as their first occurrence. Each next one is the
  same day `n` years or months later, clamped to the month's length but always measured from the
  stored day (a monthly 31st: Jan 31, Feb 28, Mar 31, Apr 30…; Feb 29 is Feb 28 in other years).
  An occurrence is over at its exact minute (with a time) or at the end of its day (date only,
  "Today" all day); then the next one shows. The bar runs from the end of the previous occurrence
  (or from when you added it, if later).
- **Goal pace** is `target × elapsed`, where `elapsed` is real time from the start of the first day
  to the end of the last day of the goal's period (so DST days count as 23 or 25 hours, like the
  rows). The verdict rounds `count − pace` to whole units: within half a unit is "on pace". A count
  at or above the target is "goal reached" (even early); a period that ended short says "ended 7
  books short"; one that hasn't started says "starts in 12 days". "This year / quarter / month" is
  fixed to the dates when you save the goal (editing a running goal keeps them); saving a goal whose
  period is over moves it to the current one. Units are written the way you type them for several ("books"); for exactly 1 the
  unit is left out ("1 behind pace") instead of guessing a singular.
- **Share card** blocks are `floor(fraction × 20)`, like the percentages: the 20th block fills only
  when the period is over.

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

The share card is checked for real: its pixels (theme background, 15 of 20 blocks in the accent
color), the downloaded file (a 1200×630 PNG named `progress-tab-2026.png`) and Copy image, by
pressing Ctrl+V in the page and reading the pasted PNG. Quick links are opened for real too: the
test answers `https://news.example.com/…` itself (Playwright routing, no network) and checks that
no referrer was sent.

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
is easy (about 405 KB including the fonts; `newtab.js` is about 170 KB). `npm run package` builds,
checks and zips it into `release/progress-tab-<version>.zip`.

### Icons

`static/icons/icon.svg` is the source; the PNGs are rendered from it and committed. After changing
the SVG: `node scripts/make-icons.mjs` (uses `CHROMIUM_PATH` or the auto-detected Chromium).

## Project structure

```
src/
  core/         Pure logic, no DOM or Chrome APIs, all tested:
                  time.ts       period boundaries, calendar differences (local time, DST-safe)
                  periods.ts    what each row shows (labels, captions, time left)
                  countdown.ts  countdown model: parsing, validation, repeats, state, sorting, sanitizing
                  goals.ts      goals: periods, pace and verdict, validation, list operations
                  links.ts      quick links: http(s)-only URL parsing, letters, reorder, sanitizing
                  share.ts      share card text model and the 20-block bar
                  format.ts     English formatting (percent, durations long and short, dates, 12/24 h)
                  settings.ts   settings model, sanitizeSettings, applyEntitlements
                  plan.ts       Free vs Pro: EARLY_ACCESS, hasFeature, limitsFor, isEntitled
                  life.ts       Life in weeks: validation and the grid/summary model
                  themes.ts     theme and accent registry (+ contrast math)
                  widgets.ts    widget registry (what can be shown/hidden)
  storage/      chrome.storage wrappers (+ the localStorage paint-time copy of the settings)
  newtab/       The page: progress rows (hero + compact), goals, quick links, share dialog
                (canvas), countdowns, life in weeks (canvas), settings drawer, About Pro card,
                toast, ticker, theming
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
`chrome.storage.local` once and applies any difference. Until that first render the page is
`visibility: hidden` (`html.booting`), so the empty card shells never flash. The e2e test checks the rows exist before
the first contentful paint (typically rendered 40–150 ms after navigation start, headless, depending
on machine load). The ticker
aligns to whole seconds, writes only changed text/attributes, moves bars with `transform`, and
stops while the tab is hidden. Life in weeks is one `<canvas>` (about 4,000 squares in three
batched paths), redrawn only when the week, the settings, the theme or the card width changes.
Goals move their pace marker with the calendar but, like everything else, write to the DOM only
when a rounded value changes. The share card is drawn only when the dialog opens or an option
changes.

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
- Goals count whole numbers (0–1,000,000); there are no fractions ("12.5 km"). The unit is used
  as typed, and left out for exactly 1 rather than guessing its singular. Year, quarter and month
  goals don't roll over by themselves: after the period they show the final verdict ("ended 3
  books short" or "goal reached"). Opening such a goal and saving it starts it for the current
  year, quarter or month (the form says so); set "Done so far" to 0 to start from scratch.
- Quick links open in the same tab and show letters, not site icons (icons would need a permission
  or a request to each site). There is no drag and drop; reorder with the ← / → buttons.
- The share card uses the page's fonts; a countdown name in a script those fonts don't cover
  (Latin, Latin Extended, Cyrillic) is drawn with the system font. Copy image was verified in
  Chromium 141 (headless, by pasting); other browsers' clipboard rules may differ, and Download PNG
  is always there.
- Repeating countdowns repeat yearly or monthly only (no weekly or custom intervals).
- Payments aren't implemented: during early access everyone has Pro, and "Get Pro" is disabled.
- The UI is English only.
