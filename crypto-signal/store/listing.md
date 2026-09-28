# Chrome Web Store listing: CryptoSignal AI

## Name

CryptoSignal AI

## Short description (≤ 132 characters, same as the manifest)

Understand crypto market momentum in seconds: RSI, MACD and EMA signals with a plain-language explanation.

## Category

Tools (alternative: Productivity)

## Detailed description

Understand crypto market momentum in seconds.

CryptoSignal AI turns a coin's recent price candles into one clear, honest summary. Open it on
Bitcoin, Ethereum, Solana or any other coin and you see:

• A signal: Strong bullish, Bullish, Neutral, Bearish or Strong bearish
• Signal strength: how strongly the indicators agree (not a probability of profit)
• Price and 24h change
• Six indicators with their values and points: RSI (14), MACD (12, 26, 9), price vs EMA50,
  EMA20 vs EMA50, momentum and volume
• A mini chart with price, EMA20 and EMA50
• A short explanation in plain words, and a "Why this signal" list of what supports the signal
  and what goes against it

Alerts and watchlist (Pro, free during early access):
• Get a notification when an indicator event happens: the signal turns bearish or bullish, RSI
  crosses a level, or the price crosses a level you choose. Checked in the background about every
  15 minutes; click the notification to open the analysis.
• Keep a watchlist of up to 8 coins with their last signal.
Alerts describe indicator events. They never tell you to buy or sell.

Timeframes: 1 hour, 4 hours, 1 day.
Coins: BTC, ETH, SOL, XRP, DOGE, BNB, ADA and AVAX built in; search finds other coins traded
against USDT on Binance.

Works where you are:
• Open it on an exchange or price page (for example a BTC/USDT trading page or a "Solana price"
  page) and it picks that coin.
• Select a ticker or coin name on any page, right-click, and choose "CryptoSignal AI → Analyze
  selected coin".

Honest by design:
• The signal describes current momentum from standard technical indicators. It does not predict
  prices and does not promise profits.
• When market data can't be loaded, it says why (no connection, rate limit, exchange outage) and
  shows no numbers. Older cached data is clearly marked as stale.
• Past analyses are kept as dated snapshots, never mixed up with live data.

Market data comes from the public Binance API, with Coinbase Exchange as a fallback. No account,
no API key, no wallet connection, no trading.

CryptoSignal AI provides technical market analysis for informational purposes only. It is not
financial advice and does not guarantee future performance.

## Single purpose

Show a technical-analysis signal (RSI, MACD, EMA, momentum, volume) and a plain-language
explanation for a cryptocurrency, using public market data, and optionally notify the user when
the signal or an indicator of a coin they chose changes.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's settings, recent analyses, alerts and watchlist locally, caches prices for 60 seconds, and passes the coin chosen from the context menu or a clicked alert to the popup. |
| `contextMenus` | Adds "CryptoSignal AI → Analyze selected coin" for selected text. |
| `alarms` | Runs the background check for the user's own alerts and watchlist about every 15 minutes. The alarm exists only while the user has at least one active alert or watched coin, and is removed when they are deleted or paused. |
| `notifications` | Shows a notification when one of the user's alerts fires (for example "BTC/USDT 4h · Signal turns bearish"). Clicking it opens that analysis in the popup. No other notifications are shown. |
| `activeTab` | When the user opens the popup, reads the current tab's URL and title to detect which coin the page is about. No access to any tab otherwise. |
| `scripting` | When the user opens the popup, runs one function in the current tab that returns the text of the page's main heading (`<h1>`), also for coin detection. Nothing else is read or changed. |
| Host `https://api.binance.com/*` | Downloads public price candles, the 24h ticker and the list of tradable coins from Binance's public market-data API. |
| Host `https://api.exchange.coinbase.com/*` | Fallback source for the same public market data when Binance is unavailable. |

Remote code: none. All code is bundled in the package.

## Privacy practices (data usage disclosure)

- Personally identifiable information, health, financial or payment information, authentication
  information, personal communications, location, user activity: **not collected**.
- Website content: the current tab's URL, title and main heading are read **locally** when the user
  opens the popup, to pick a coin. They are not stored or transmitted.
- Network requests go only to the Binance and Coinbase public market-data APIs and contain only the
  coin ticker and timeframe (for example `symbol=BTCUSDT&interval=4h`), also for background alert
  checks. No cookies, identifiers or page data are sent.
- Settings, analysis history, alerts and the watchlist are stored in `chrome.storage.local` on the
  user's device and can be deleted in the popup or Settings. Notifications are shown locally. The price cache lives in `chrome.storage.session` and is discarded when the
  browser closes.
- No analytics, no ads, no data sale or transfer to third parties.

Certify: data is not sold, not used for purposes unrelated to the single purpose, and not used to
determine creditworthiness.

## Privacy policy (short form for the listing URL)

CryptoSignal AI does not collect, store on any server, or share personal data. It downloads public
cryptocurrency prices from Binance and Coinbase using only the coin ticker and timeframe. To detect
the coin on the page you're viewing, it reads that page's address, title and main heading on your
device when you open it; this information never leaves your browser. Your settings and analysis
history are stored only in your browser and can be deleted in Settings or by removing the extension.

## Screenshots

Captured by the e2e suite at 2× (760 px wide popups). The Web Store requires 1280 × 800 or
640 × 400 images, so place each capture on a 1280 × 800 dark (#0b0e11) canvas before uploading.

1. `screenshots/bullish-popup.png`: Strong bullish BTC/USDT with price, signal strength and chart
2. `screenshots/bearish.png`: Bearish ETH with indicators, analysis and "Why this signal"
3. `screenshots/neutral.png`: Neutral market with mixed readings
4. `screenshots/detected.png`: Coin detected from the exchange page you're on
5. `screenshots/search.png`: Search other coins
6. `screenshots/history.png`: History of past analyses
7. `screenshots/stale.png`: Clearly marked stale data when a refresh fails
8. `screenshots/rate-limited.png`: Rate limit with countdown, no fake data
9. `screenshots/alerts.png`: Alerts and watchlist (indicator events, background checks)
10. `screenshots/settings.png`: Settings with the About Pro card (`screenshots/about-pro.png` for a close-up)

Other captures in `screenshots/` (loading, error, fallback, snapshot, free-preview) document the
remaining states for review.

## Before submitting

- Verify live data on a normal network (the development environment could not reach the APIs).
- Verify alert notifications on a real desktop (tested only via `chrome.notifications.getAll()` in
  headless Chromium), including a click opening the popup.
- Replace fixture-based screenshots with live ones if preferred.
- Zip the contents of `dist/` (not the folder itself).
