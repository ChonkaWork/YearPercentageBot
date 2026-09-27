export type DataErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_MARKET'
  | 'MISSING_HISTORY';

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
    readonly details: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'DataError';
  }
}

export function isDataError(error: unknown): error is DataError {
  return error instanceof DataError;
}

export interface ErrorDescription {
  title: string;
  message: string;
  /** Show a Retry button. */
  retry: boolean;
  /** Offer search as a way forward. */
  search: boolean;
}

/** What the user sees for each failure. None of these paths produce an analysis. */
export function describeError(error: unknown): ErrorDescription {
  if (!isDataError(error)) {
    return { title: 'Something went wrong', message: 'The market data could not be processed. No analysis was generated.', retry: true, search: true };
  }
  switch (error.code) {
    case 'NETWORK':
      return { title: "Can't reach Polymarket", message: 'Check your internet connection and try again.', retry: true, search: false };
    case 'TIMEOUT':
      return { title: 'Polymarket is taking too long', message: 'The request timed out. Try again in a moment.', retry: true, search: false };
    case 'RATE_LIMITED': {
      const wait = error.details.retryAfterSeconds;
      return {
        title: 'Too many requests',
        message: `Polymarket is limiting requests right now. Try again ${wait ? `in ${wait} s` : 'in a minute'}.`,
        retry: true,
        search: false,
      };
    }
    case 'NOT_FOUND':
      return { title: 'Market not found', message: "Polymarket's API has no market for this page. It may have been removed or renamed.", retry: false, search: true };
    case 'UNAVAILABLE':
      return {
        title: 'Polymarket data is unavailable',
        message: `The data service answered with an error${error.details.status ? ` (HTTP ${error.details.status})` : ''}. Try again shortly.`,
        retry: true,
        search: false,
      };
    case 'INVALID_RESPONSE':
      return { title: "Couldn't read the market data", message: 'Polymarket returned data in an unexpected format. No analysis was generated.', retry: true, search: true };
    case 'UNSUPPORTED_MARKET':
      return { title: "This market can't be analyzed", message: error.message, retry: false, search: true };
    case 'MISSING_HISTORY':
      return { title: 'No price history', message: 'Polymarket has no price history for this market yet.', retry: true, search: false };
  }
}
