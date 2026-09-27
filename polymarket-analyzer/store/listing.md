# Chrome Web Store listing: Polymarket AI Analyzer

## Name

Polymarket AI Analyzer

## Short description (132 characters max)

Analyze Polymarket markets with probability, momentum, volume, liquidity and AI-powered explanations.

> Note for the owner: in this version the explanation text is written by a deterministic, local
> generator (templates filled with the market's numbers), not by a language model. The
> `AIExplanationService` interface is ready for a model later. If the listing should describe the
> current version strictly, use: "Analyze Polymarket markets with probability, momentum, volume,
> liquidity and plain-language explanations." (107 characters)

## Category

Productivity (alternative: Tools)

## Detailed description

Polymarket AI Analyzer answers one question: what is happening with this Polymarket market right
now, and why?

Open the extension on a Polymarket market page and it reads the market from Polymarket's public
data, then shows:

- **Current probability**: the market price of Yes/No, or the current leader of a multi-outcome
  event.
- **Momentum signal**: Strong positive, Positive, Neutral, Negative or Strong negative momentum,
  with a signal strength from 0 to 100. It is computed from the 24-hour and 7-day price changes,
  trading volume, liquidity and volatility. It describes recent price movement, not the chance that
  the event happens.
- **Market data**: 24h and 7d change, 24h volume compared with the recent daily average, liquidity
  (low / medium / high) and volatility.
- **Price chart**: 24 hours, 7 days or 30 days, with significant moves marked.
- **Why is it moving?**: the factors behind the signal, taken from the data (price change, trend,
  volume, liquidity, volatility).
- **Unusual activity**: large moves, volume spikes, sudden reversals and big moves in thin markets,
  shown with the numbers. It never guesses at causes.
- **Plain-language summary**: two to four sentences built only from the numbers above.
- **Multi-outcome events**: all outcomes sorted by probability with their 24h and 7d changes. Click
  an outcome to analyze it.
- **Related markets** from the same event.

Also included:

- **Search** Polymarket markets from the popup, or select text on any page and choose
  *Polymarket AI → Analyze this market* in the right-click menu.
- **Watchlist**: follow markets, see how their probability changed since the last refresh, and get
  in-popup notes when a market moves more than 5 points, its volume doubles, or its momentum flips.
- **History**: every analysis is kept as a dated snapshot you can reopen.
- **Compare**: put two or three markets side by side.

What it is not: it does not predict outcomes, does not claim to know anything beyond public market
data, and does not point out "mispriced" markets, arbitrage or guaranteed profit. It has no wallet,
no trading and no betting features. Informational only; not financial advice.

Polymarket AI Analyzer is an independent tool and is not affiliated with, endorsed by or sponsored
by Polymarket.

## Privacy

Single purpose: show an analysis of Polymarket prediction markets.

- **No account, no backend, no analytics, no ads, no remote code.** All analysis runs inside the
  extension.
- **Network requests** go only to Polymarket's public data APIs (`gamma-api.polymarket.com` and
  `clob.polymarket.com`). They contain the market identifier from the page you opened the
  extension on, or the search text you typed or selected. No cookies or credentials are sent
  (`credentials: 'omit'`, no referrer).
- **Page access**: the extension reads the address of the current tab only after you click its
  button or its context-menu item (activeTab). On Polymarket pages whose address doesn't name a
  market, it reads that page's canonical link once. It does not read page content otherwise and
  does not run on pages in the background.
- **Stored data** (watchlist and analysis history) stays in `chrome.storage.local` in this browser.
  API responses are cached for the browser session in `chrome.storage.session`. Nothing is synced
  or sold. Removing the extension deletes it.

Privacy practices form (Chrome Web Store dashboard):

- Data collected: none. (Search text and market identifiers are sent to Polymarket's API to fetch
  the data the user asked for; they are not collected by the developer.)
- Not sold to third parties, not used for purposes unrelated to the single purpose, not used for
  creditworthiness or lending.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Read the address of the current tab when the user opens the extension or uses its context menu, to find which Polymarket market is open. No access to any tab otherwise. |
| `scripting` | Only on Polymarket pages whose address doesn't contain a market (for example sports game pages), run one small function after the user opens the extension to read the page's canonical link. No content scripts, nothing injected in the background. |
| `contextMenus` | The "Polymarket AI → Analyze this market" item on Polymarket market pages and on selected text (search). |
| `storage` | Keep the watchlist and analysis history locally, and cache API responses for 60 seconds within the browser session. |
| Host `https://gamma-api.polymarket.com/*` | Polymarket's public market data API: markets, events, search. |
| Host `https://clob.polymarket.com/*` | Polymarket's public price history endpoint for the chart and volatility. |

No `tabs`, `<all_urls>`, `webRequest`, cookies, or access to polymarket.com pages themselves.

Remote code: none. All JavaScript, CSS, fonts and icons are bundled in the package.

## Screenshots

Chrome Web Store screenshots must be 1280×800 or 640×400. The popup is 400×600, so each store image
should place a popup capture from `screenshots/` on a plain background (#0b1020) at 640×400 (scaled)
or 1280×800. Suggested set, in order:

1. `binary-positive.png`: a market with positive momentum (hero shot)
2. `multi-outcome-full.png` (top part): multi-outcome event with the market leader and outcomes table
3. `unusual-activity-full.png` (top part): unusual activity with the numbers behind it
4. `low-liquidity-full.png` (chart and data part): low-liquidity warning, market data rows
5. `watchlist.png`: watchlist with a change arrow and an alert
6. `compare-full.png`: side-by-side comparison

All screenshots use fixture data from the automated tests (fictional prices), not live markets.

## Promotional tile (440×280)

Brand tile #2e5cff with the rising-line mark (assets/icon.svg) and the name. No Polymarket logo.

## Support / homepage

To be filled in by the owner (support email and a public privacy policy URL are required before
submission).
