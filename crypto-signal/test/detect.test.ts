import { describe, expect, it } from 'vitest';
import { detectCoin, detectFromSelection, detectFromUrl } from '../src/core/detect';

describe('detectFromUrl: exchanges and charting sites', () => {
  it.each([
    ['https://www.binance.com/en/trade/BTC_USDT?type=spot', 'BTC'],
    ['https://www.binance.com/en/futures/ETHUSDT', 'ETH'],
    ['https://www.binance.com/en/price/solana', 'SOL'],
    ['https://www.coinbase.com/advanced-trade/spot/XRP-USD', 'XRP'],
    ['https://www.coinbase.com/price/dogecoin', 'DOGE'],
    ['https://pro.kraken.com/app/trade/xbt-usd', 'BTC'],
    ['https://www.kraken.com/prices/cardano', 'ADA'],
    ['https://www.bybit.com/trade/spot/AVAX/USDT', 'AVAX'],
    ['https://www.okx.com/trade-spot/bnb-usdt', 'BNB'],
    ['https://www.tradingview.com/symbols/BTCUSDT/', 'BTC'],
    ['https://www.tradingview.com/symbols/BINANCE-SOLUSDT/', 'SOL'],
    ['https://www.tradingview.com/chart/abc123/?symbol=BINANCE%3AETHUSDT', 'ETH'],
    ['https://www.coingecko.com/en/coins/bitcoin', 'BTC'],
    ['https://www.coingecko.com/en/coins/avalanche-2', 'AVAX'],
    ['https://coinmarketcap.com/currencies/xrp/', 'XRP'],
    ['https://www.binance.com/en/trade/PEPE_USDT', 'PEPE'],
    ['https://www.tradingview.com/symbols/LINKUSDT/', 'LINK'],
  ])('%s → %s', (url, symbol) => {
    expect(detectFromUrl(url)).toBe(symbol);
  });

  it.each([
    'https://www.example.com/travel/canada-guide',
    'https://www.example.com/solutions/enterprise',
    'https://news.example.com/2026/usd-eur-exchange-rate',
    'https://blog.example.com/posts/crypto-usd-rates', // unknown "CRYPTO" base off exchange sites
    'https://www.binance.com/en/markets/overview',
    'chrome://extensions',
    'not a url',
  ])('%s → nothing', (url) => {
    expect(detectFromUrl(url)).toBeNull();
  });

  it('ignores fiat and stablecoin "bases"', () => {
    expect(detectFromUrl('https://www.binance.com/en/trade/USDC_USDT')).toBeNull();
    expect(detectFromUrl('https://www.tradingview.com/symbols/EURUSD/')).toBeNull();
  });
});

describe('detectCoin: title and heading', () => {
  it('prefers the URL over the title', () => {
    expect(detectCoin({ url: 'https://www.binance.com/en/trade/SOL_USDT', title: 'Bitcoin price today' })).toEqual({ symbol: 'SOL', via: 'url' });
  });

  it.each([
    ['Bitcoin price today, BTC to USD live price', 'BTC'],
    ['BTC/USDT 64,210.55 ▲ +1.2%', 'BTC'],
    ['Ethereum (ETH) Price, Charts and News', 'ETH'],
    ['Solana hits new high as memecoin trading surges', 'SOL'],
    ['$DOGE and $SHIB rally', 'DOGE'],
    ['XRP climbs after court ruling', 'XRP'],
    ['Cardano price prediction: ADA outlook', 'ADA'],
    ['Avalanche (AVAX) token staking guide', 'AVAX'],
    ['BNB Chain upgrade goes live', 'BNB'],
    ['Why Bitcoin vs Ethereum matters', 'BTC'],
  ])('title "%s" → %s', (title, symbol) => {
    expect(detectCoin({ url: 'https://news.example.com/article', title })).toEqual({ symbol, via: 'title' });
  });

  it('falls back to the heading', () => {
    expect(detectCoin({ url: 'https://example.com/a', title: 'Markets | Example', heading: 'Dogecoin price analysis' })).toEqual({
      symbol: 'DOGE',
      via: 'heading',
    });
  });

  it.each([
    'Canada travel guide: the best of Nova Scotia', // ADA inside a word
    'Solution architects share lessons learned', // SOL inside a word
    'ETH Zurich researchers publish new study', // ETH without crypto context
    'ADA compliance checklist for websites', // ADA the act
    'DOGE cuts another agency budget', // DOGE the department
    'Avalanche warning issued for the Alps', // avalanche, the snow kind
    'The ripple effect of remote work',
    'Gerolamo Cardano and the history of probability',
    'Sol y sombra: a Madrid travel diary',
    'Rethinking btc: bike to campus week', // lowercase ticker
  ])('no false positive in "%s"', (title) => {
    expect(detectCoin({ url: 'https://news.example.com/story', title, heading: title })).toBeNull();
  });

  it('trusts ambiguous tickers on crypto sites', () => {
    expect(detectCoin({ url: 'https://www.coingecko.com/en/highlights', title: 'ADA staking rewards' })).toEqual({ symbol: 'ADA', via: 'title' });
  });

  it('returns null for empty input', () => {
    expect(detectCoin({})).toBeNull();
    expect(detectCoin({ url: null, title: null, heading: null })).toBeNull();
  });
});

describe('detectFromSelection', () => {
  it.each([
    ['BTC', 'BTC'],
    ['btc', 'BTC'],
    ['$sol', 'SOL'],
    ['ada', 'ADA'],
    ['Bitcoin', 'BTC'],
    ['ethereum.', 'ETH'],
    ['Binance Coin', 'BNB'],
    ['XBT', 'BTC'],
    ['BTC/USDT', 'BTC'],
    ['ethusdt', 'ETH'],
    ['SOL-USD', 'SOL'],
    ['PEPE', 'PEPE'],
    ['"LINK"', 'LINK'],
    ['I think Solana looks strong this week', 'SOL'],
    ['Is DOGE still a thing?', 'DOGE'],
  ])('"%s" → %s', (selection, symbol) => {
    expect(detectFromSelection(selection)).toBe(symbol);
  });

  it.each(['', '   ', 'USDT', 'EUR', 'hello there, how are you doing today', '12345', 'x'])('"%s" → nothing', (selection) => {
    expect(detectFromSelection(selection)).toBeNull();
  });
});
