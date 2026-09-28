// Local stand-in for the Binance and Coinbase public APIs (which the test environment can't
// reach). It replays the recorded-style payloads in e2e/fixtures/api/ and can switch each
// provider into a failure mode, the way the real APIs fail:
//
//   ok          documented payloads
//   451 / 403   geo-block (Binance: "Service unavailable from a restricted location")
//   429         rate limit with Retry-After
//   500         server error
//   malformed   HTTP 200 with a body that breaks the documented format
//   reset       connection dropped without a response (network failure)
//
// `scenario.swap` serves one Binance market's payloads for another ({ BTCUSDT: 'ETHUSDT' }), so
// the alert tests can make a market's signal, RSI and price change between two checks.
//
// It also serves the HTML pages used for page detection under /pages/.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const PAGES = {
  '/pages/en/trade/SOL_USDT': 'exchange.html',
  '/pages/travel/canada': 'canada.html',
  '/pages/news/markets': 'news.html',
};

export function createScenario() {
  return { binance: 'ok', coinbase: 'ok', retryAfter: '30', delayMs: 0, swap: {} };
}

export async function startFixtureServer(port) {
  const scenario = createScenario();
  /** Every API request, as "binance /api/v3/klines?…" strings. */
  const log = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname in PAGES) {
        const body = await readFile(join(fixtures, 'pages', PAGES[url.pathname]));
        return send(response, 200, body, 'text/html; charset=utf-8');
      }
      const [, provider, ...rest] = url.pathname.split('/');
      if (provider !== 'binance' && provider !== 'coinbase') return send(response, 404, 'not found', 'text/plain');
      const path = `/${rest.join('/')}`;
      log.push(`${provider} ${path}${url.search}`);
      if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
      const mode = scenario[provider];
      if (mode === 'reset') return request.socket.destroy();
      if (mode !== 'ok' && mode !== 'malformed') return failure(response, provider, mode, scenario.retryAfter);
      if (provider === 'binance') {
        const params = new URLSearchParams(url.searchParams);
        const symbol = params.get('symbol');
        if (symbol && scenario.swap[symbol]) params.set('symbol', scenario.swap[symbol]);
        return await binance(response, path, params, mode);
      }
      return await coinbase(response, path, url.searchParams, mode);
    } catch (error) {
      send(response, 500, String(error), 'text/plain');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    scenario,
    log,
    origin: `http://127.0.0.1:${port}`,
    reset() {
      Object.assign(scenario, createScenario());
      log.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function send(response, status, body, type = 'application/json', headers = {}) {
  response.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...headers });
  response.end(body);
}

const json = (response, status, data, headers) => send(response, status, JSON.stringify(data), 'application/json', headers);

async function fixture(path) {
  try {
    return await readFile(join(fixtures, 'api', path), 'utf8');
  } catch {
    return null;
  }
}

function failure(response, provider, mode, retryAfter) {
  const status = Number(mode);
  if (provider === 'binance') {
    const messages = {
      451: { code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms." },
      403: { code: 0, msg: 'Forbidden' },
      429: { code: -1003, msg: 'Too many requests; current limit of IP is 6000 requests per minute.' },
      500: { code: -1001, msg: 'Internal error; unable to process your request. Please try again.' },
    };
    return json(response, status, messages[status] ?? { code: -1000, msg: 'Unknown error.' }, status === 429 ? { 'retry-after': retryAfter } : {});
  }
  const messages = { 403: 'Forbidden', 429: 'Public rate limit exceeded', 500: 'Internal server error' };
  return json(response, status, { message: messages[status] ?? 'error' }, status === 429 ? { 'retry-after': retryAfter } : {});
}

const INVALID_SYMBOL = { code: -1121, msg: 'Invalid symbol.' };

async function binance(response, path, params, mode) {
  if (path === '/api/v3/klines') {
    const body = await fixture(`binance/klines-${params.get('symbol')}-${params.get('interval')}.json`);
    if (!body) return json(response, 400, INVALID_SYMBOL);
    const rows = JSON.parse(body).slice(-Number(params.get('limit') ?? 500));
    if (mode === 'malformed') rows[rows.length - 3][4] = 'NaN';
    return json(response, 200, rows);
  }
  if (path === '/api/v3/ticker/24hr') {
    const body = await fixture(`binance/ticker-${params.get('symbol')}.json`);
    if (!body) return json(response, 400, INVALID_SYMBOL);
    return send(response, 200, mode === 'malformed' ? '{"symbol":' : body);
  }
  if (path === '/api/v3/ticker/price') return send(response, 200, (await fixture('binance/ticker-price.json')) ?? '[]');
  return json(response, 404, { code: -1, msg: 'Unknown endpoint.' });
}

async function coinbase(response, path, params, mode) {
  const candles = /^\/products\/([A-Z0-9]+-[A-Z]+)\/candles$/.exec(path);
  if (candles) {
    const body = await fixture(`coinbase/candles-${candles[1]}-${params.get('granularity')}.json`);
    if (!body) return json(response, 404, { message: 'NotFound' });
    return mode === 'malformed' ? json(response, 200, { message: 'unexpected' }) : send(response, 200, body);
  }
  const stats = /^\/products\/([A-Z0-9]+-[A-Z]+)\/stats$/.exec(path);
  if (stats) {
    const body = await fixture(`coinbase/stats-${stats[1]}.json`);
    if (!body) return json(response, 404, { message: 'NotFound' });
    return send(response, 200, body);
  }
  if (path === '/products') return send(response, 200, (await fixture('coinbase/products.json')) ?? '[]');
  return json(response, 404, { message: 'NotFound' });
}
