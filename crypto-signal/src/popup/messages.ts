import { PROVIDER_NAMES, type ProviderId } from '../core/types';
import type { MarketDataError, MarketErrorCode } from '../data/errors';
import type { ProviderAttempt } from '../data/market';
import type { IconName } from '../ui/icons';

export interface ErrorCopy {
  title: string;
  body: string;
  icon: IconName;
  tone: 'error' | 'caution';
}

const QUOTES: Record<ProviderId, string> = { binance: 'USDT', coinbase: 'USD' };

/** What happened and what to do, in plain words. */
export function describeError(error: MarketDataError, symbol: string): ErrorCopy {
  switch (error.code) {
    case 'rate-limited':
      return {
        title: 'Rate limit reached',
        body: 'The market data servers are limiting requests right now. CryptoSignal waits as long as they ask before trying again.',
        icon: 'hourglass',
        tone: 'caution',
      };
    case 'blocked':
      return {
        title: "Market data isn't reachable from here",
        body: 'The exchanges refused the connection from your location or network, so no price or signal can be shown. A different network may work.',
        icon: 'shieldLock',
        tone: 'error',
      };
    case 'network':
      return {
        title: 'No connection',
        body: "Couldn't reach the market data servers. Check your internet connection and try again.",
        icon: 'wifiOff',
        tone: 'error',
      };
    case 'timeout':
      return {
        title: "The exchange didn't respond",
        body: 'The request took too long. Try again in a moment.',
        icon: 'hourglass',
        tone: 'error',
      };
    case 'unavailable':
      return {
        title: 'Market data is unavailable',
        body: 'The exchanges returned an error. This is usually temporary; try again in a minute.',
        icon: 'cloudSlash',
        tone: 'error',
      };
    case 'malformed':
      return {
        title: 'Unexpected data',
        body: "The exchange returned data CryptoSignal couldn't read, so no signal is shown rather than a wrong one.",
        icon: 'exclamationOctagon',
        tone: 'error',
      };
    case 'invalid-symbol':
      return {
        title: `${symbol} isn't available`,
        body: `Neither Binance (${symbol}/${QUOTES.binance}) nor Coinbase (${symbol}-${QUOTES.coinbase}) lists this market. Choose another coin.`,
        icon: 'slashCircle',
        tone: 'caution',
      };
  }
}

const CODE_TEXT: Record<MarketErrorCode, string> = {
  blocked: 'Restricted location',
  unavailable: 'Server error',
  'rate-limited': 'Rate limited',
  'invalid-symbol': 'Not listed',
  malformed: 'Unreadable data',
  network: 'No connection',
  timeout: 'Timed out',
};

/** "Binance · Restricted location (HTTP 451)" rows for the error card. */
export function attemptRows(attempts: readonly ProviderAttempt[]): { provider: string; outcome: string }[] {
  return attempts.map((attempt) => ({
    provider: PROVIDER_NAMES[attempt.provider],
    outcome: `${CODE_TEXT[attempt.code]}${attempt.status ? ` (HTTP ${attempt.status})` : ''}${attempt.skipped ? ', waiting' : ''}`,
  }));
}

/** Short reason used in stale-data notices. */
export function shortReason(error: MarketDataError): string {
  return CODE_TEXT[error.code].toLowerCase();
}
