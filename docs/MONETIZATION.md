# Free vs Pro: features, prices, payments

Source of truth for what each extension gives away and what it charges for. Every extension
implements the same **plan seam** described below, so switching payments on later is a
configuration change, not a rewrite.

## Principles

- **Free must be genuinely useful on its own.** The free version is what earns installs, ratings
  and search ranking. Pro is for people who use it daily and want more.
- **Charge for depth, not for the basics.** Limits (count, frequency), power features (custom
  rules, bulk, automation, more formats) and convenience (themes, history, sync) are Pro. The
  core job of the listing is never paywalled.
- **One-time payments first.** Everything runs locally, so there is no server cost to justify a
  subscription. One-time is also easier to sell for $2–4. Exceptions noted below.
- **No dark patterns.** No nag screens, no countdown timers, no locking data the user created.
  Pro features show a small `PRO` badge and a short explanation; that's it.

## Price floor: why not $0.99

Payment providers charge roughly **$0.30–0.50 + 3–10 %** per transaction (card fee + platform or
merchant-of-record fee). On $0.99 that's 35–50 % gone; on $1.99 about 20–25 %; on $2.99 about
15–20 %. So:

- **Minimum price: $1.99.** Default: **$2.99 one-time**.
- A **bundle "All Pro"** (every extension) at **$9.99** once more than two listings have traction.
  Only possible with license keys that work across extensions (see Payments).

## The plan seam (every extension)

`src/core/plan.ts` (pure, unit-tested):

```ts
export type Plan = 'free' | 'pro';
export type ProFeature = 'templates' | 'history-search' | ...; // per extension
/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';
export function hasFeature(plan: Plan, feature: ProFeature): boolean;
export function limitsFor(plan: Plan): { ... }; // e.g. { maxSnippets: 20 }
```

- The stored plan lives in `chrome.storage.local` (`plan`, sanitized on read, default `'free'`).
  `EARLY_ACCESS` makes `hasFeature` return true for everything.
- Every Pro check in the UI and in background code goes through `hasFeature` / `limitsFor`. No
  scattered `if (pro)`.
- UI: a `PRO` badge next to Pro features; an **"About Pro"** card on the options page listing the
  Pro features, the price and a **Get Pro** button. While `EARLY_ACCESS` is true, the card says
  "Free during early access" and the button is disabled.
- When a free user hits a limit: a calm inline message ("Free keeps 20 snippets. Pro removes the
  limit.") with a link to the About Pro card. Never block or delete existing data.
- `src/core/plan.ts` must stay free of payment SDK code; a future `src/payments/` adapter sets the
  stored plan.

## Per extension

| Extension | Free | Pro | Price |
| --- | --- | --- | --- |
| **Pastebot** | All 7 actions, context menu, panel, shortcut, 20 prompts of history | **Custom templates** (your own actions with your own instruction text, shown in the menu and panel), history up to 500 with **search**, pinned favourites | $2.99 |
| **Universal Copy** | Clean text, Markdown, HTML, table copy (CSV/TSV/MD/JSON) | **Download as file** (.md / .csv / .json), **copy link as Markdown** `[title](url)` for the page, Markdown options presets | $2.99 |
| **Clean Copy** | Clean-copy shortcut and menu, strip tracking parameters from copied links, keep/merge line breaks | **Auto-clean every Ctrl+C** on chosen sites (optional per-site permission), **custom cleanup rules** (find/replace, regex) | $1.99 |
| **Table Copy** | Copy any table as CSV / TSV / Markdown / JSON, table list in the popup | **Download .xlsx**, **column picker** (choose/reorder columns before copying), merge several tables into one | $2.99 |
| **Snippets** | Up to 20 snippets, all variables, per-site pause | **Unlimited snippets**, **folders/tags**, **fill-in fields** `{input:Name}` asked at expansion time | $3.99 |
| **Chat Exporter** | Copy as Markdown, download .md and .txt | **JSON and PDF**, **Obsidian/Notion-friendly Markdown** (front matter), include/exclude code blocks | $2.99 |
| **AI Chat Search** | Index and search up to 100 conversations | **Unlimited index**, **favourites/tags**, export the index | $2.99 |
| **Page Watch** | 3 watches, intervals from 1 hour | **Unlimited watches**, **intervals from 5 minutes**, keyword and price rules | $3.99 |
| **Video Speed+** | All shortcuts, overlay, remember speed | **Per-site default speeds**, **custom presets** in the popup, **skip-silence off / on per site** (only if feasible) | $1.99 |
| **Progress Tab** | Year/month/week/day, up to 3 countdowns, 2 themes | **Unlimited countdowns**, **theme pack**, **"life in weeks"** widget | $1.99 |
| **CryptoSignal AI** | BTC and ETH, 4h timeframe, 10 analyses a day | **All coins**, **1h/4h/1d**, **price/signal alerts** (background checks + notification), **watchlist**, history | $2.99 |
| **Polymarket AI Analyzer** | Market analysis, 5-market watchlist, 24h/7d | **Unlimited watchlist**, **alerts** (move > X pp), compare view, 30D charts | $2.99 |
| **YouTube Focus** (13th) | Hide Shorts, home recommendations, comments, end screens | **Focus schedule** (on during set hours), **per-channel allowlist**, hide-everything-but-subscriptions mode | $1.99 |

## Store policy: avoid "duplicate functionality"

Chrome Web Store's spam policy forbids publishing multiple extensions with duplicate experiences.
Clean Copy and Table Copy overlap with Universal Copy, so each must stay distinct:

- **Clean Copy** is about *automatic* cleaning of ordinary copies (Ctrl+C on chosen sites, rules).
- **Table Copy** is about *tables as data* (xlsx, column picker, merging).
- **Universal Copy** is the multi-format converter for selections.

Different names, icons, screenshots, descriptions and primary features. Publish Universal Copy
**or** the two focused ones first, not all three on day one; add the rest only if the first shows
traction.

## Payments (decide before flipping `EARLY_ACCESS`)

Chrome Web Store has no built-in payments any more. Options:

| Option | How | Fees (approx.) | Notes |
| --- | --- | --- | --- |
| ExtensionPay | JS library + hosted checkout, Stripe underneath | Stripe fee + 5 % | Easiest integration, per extension. Needs a Stripe account, which is **not available to Ukraine-based individuals/companies**, so only viable with a foreign entity |
| Lemon Squeezy / Paddle (merchant of record) | License keys; extension verifies a key once | ~5 % + $0.50 | Handles VAT/sales tax. Check payout support for Ukraine before choosing |
| Gumroad | License keys | ~10 % + card fee | Simple, license keys work across products (bundle) |

Recommendation: a **merchant of record with license keys** (check which one pays out to your
country), because it handles taxes, supports a cross-extension bundle and needs no backend of our
own. The extension calls the provider's license-verify endpoint once on activation (the only
network call, declared as a narrow host permission) and stores `plan: 'pro'`.

These fee numbers and country support change; verify on each provider's current pricing page
before deciding.
