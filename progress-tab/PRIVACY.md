# Progress Tab privacy policy

Last updated: 28 September 2026

Progress Tab replaces Chrome's new tab page with the progress of the year, month, week and day,
your goals for the year, quick links and your own countdowns. It works entirely inside your
browser. It has no server, no account,
no analytics and no advertising, and it makes no network requests: the page's Content Security
Policy doesn't allow any.

## What Progress Tab reads

Nothing from the websites you visit. It has no access to any website, no content scripts and no
background script. It only shows its own new tab page.

## What Progress Tab stores

Everything is stored on your device. Nothing is synced by Progress Tab or sent anywhere.

| Data | Where | How long |
| --- | --- | --- |
| Your settings (theme, accent, clock format, week start, which widgets to show) and plan (free or Pro) | `chrome.storage.local`, plus a copy in the new tab page's `localStorage` so the theme is applied before the page first paints | Until you uninstall |
| Your countdowns (name, date, optional time, whether it repeats yearly or monthly, whether to show a progress bar, when it was added) | `chrome.storage.local` (key `countdowns`) | Until you delete them or uninstall |
| Your goals (name, unit, target, current count, period dates, when it was added) | `chrome.storage.local` (key `goals`) | Until you delete them or uninstall |
| Your quick links (name and web address) | `chrome.storage.local` (key `links`) | Until you delete them or uninstall |
| Your birth date, only if you turn on Life in weeks | With the settings, as above | Until you press **Forget birth date** or uninstall |

The settings and the plan are stored under the key `settings` and `plan`; their paint-time copies
under `progress-tab:settings` and `progress-tab:plan` in `localStorage`.

The birth date is used only to draw the Life in weeks grid on your screen (and, if you choose the
Life in weeks share card, to compute the percentage on it; the date itself is never on the card).
**Forget birth date** removes it from both places. Uninstalling Progress Tab deletes all of the
data above.

## Quick links

Quick links are web addresses you type yourself (only `http` and `https` are accepted). Progress
Tab never contacts them: it loads no site icons or previews, and each tile shows the first letter
of its name. When you click a tile your browser opens that site, as with any link; the site is not
told that you came from Progress Tab (the link is `rel="noreferrer"`).

## Share images

The **Share** button draws an image (for example "2026 is 79.00% complete") on the page itself.
**Download PNG** saves it through your browser's normal download; **Copy image** puts it on your
clipboard, and only when you click it. Progress Tab uploads nothing and posts nothing: where the
image goes next is up to you. The image contains what you picked (year, month, a countdown's name
and date, or your Life in weeks percentage) and today's date, never your birth date.

## What Progress Tab shares

Nothing. Progress Tab doesn't send, sell or share any data, and it contains no third-party code
that could.

## Permissions

- `storage`: save the settings, countdowns, goals and quick links described above.
- Downloading and copying the share image need no permission: the download is an ordinary link,
  and copying uses the clipboard only when you click **Copy image**.
- Replacing the new tab page (`chrome_url_overrides`) needs no permission. Chrome asks you on
  first use whether to keep the change.

## Chrome Web Store User Data Policy

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Data is used only to show your new tab page, is never
transferred to anyone, and is never used for advertising, credit decisions or any purpose
unrelated to that feature.

## Paid features

Pro features currently work for everyone during early access, and nothing is checked online.
If paid plans are introduced later, payment will be handled by a separate payment provider
under its own privacy policy, and this policy will be updated before that version is released.

## Children

Progress Tab is a general-purpose productivity tool and is not directed at children.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: open an issue
at <https://github.com/ChonkaWork/YearPercentageBot/issues> or write to the contact email on
Progress Tab's Chrome Web Store page.
