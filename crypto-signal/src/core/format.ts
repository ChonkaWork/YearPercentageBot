/**
 * Display formatting. Every function returns a dash for missing, NaN or infinite input, so the
 * UI can never print "NaN", "Infinity" or "undefined".
 */

export const MISSING = '—';
const MINUS = '−';

function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Prices from $0.00001 to $100,000: two decimals from 1 up, otherwise four significant digits
 * (0.4512, 0.08231, 0.00001234).
 */
export function formatPrice(value: number | null | undefined): string {
  if (!valid(value) || value < 0) return MISSING;
  if (value === 0) return '0.00';
  if (value >= 1) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const magnitude = Math.floor(Math.log10(value));
  const decimals = Math.min(10, Math.max(4, 3 - magnitude));
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "+2.34%", "−1.20%", "0.00%". */
export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (!valid(value)) return MISSING;
  const rounded = Number(value.toFixed(decimals));
  const text = Math.abs(rounded).toFixed(decimals);
  if (rounded > 0) return `+${text}%`;
  if (rounded < 0) return `${MINUS}${text}%`;
  return `${text}%`;
}

/** Plain number with fixed decimals and a real minus sign. */
export function formatNumber(value: number | null | undefined, decimals = 1): string {
  if (!valid(value)) return MISSING;
  const rounded = Number(value.toFixed(decimals));
  const text = Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return rounded < 0 ? `${MINUS}${text}` : text;
}

/** Indicator values that can be tiny (MACD on a $0.0001 coin): four significant digits. */
export function formatSignificant(value: number | null | undefined, digits = 4): string {
  if (!valid(value)) return MISSING;
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const text =
    abs >= 1000
      ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : abs.toLocaleString('en-US', { maximumSignificantDigits: digits, minimumSignificantDigits: 1 });
  return value < 0 ? `${MINUS}${text}` : text;
}

/** "1.8×". */
export function formatRatio(value: number | null | undefined): string {
  if (!valid(value) || value < 0) return MISSING;
  return `${value.toFixed(value >= 10 ? 0 : 1)}×`;
}

/** Signed points: "+2", "−1", "0". */
export function formatPoints(value: number | null | undefined): string {
  if (!valid(value)) return MISSING;
  if (value > 0) return `+${value}`;
  if (value < 0) return `${MINUS}${Math.abs(value)}`;
  return '0';
}

/** "just now", "12 sec ago", "3 min ago", "2 h ago", "yesterday", "5 days ago". */
export function formatAge(timestamp: number | null | undefined, now: number = Date.now()): string {
  if (!valid(timestamp)) return MISSING;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** "Sep 27, 14:32" in the user's time zone. */
export function formatDateTime(timestamp: number | null | undefined): string {
  if (!valid(timestamp)) return MISSING;
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** "Sep 27, 2026, 14:32" for tooltips and snapshot banners. */
export function formatFullDateTime(timestamp: number | null | undefined): string {
  if (!valid(timestamp)) return MISSING;
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** Seconds as "45 s" or "2 min 5 s" for rate-limit countdowns. */
export function formatDuration(ms: number | null | undefined): string {
  if (!valid(ms)) return MISSING;
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}
