import { sanitizeBlocklist } from './hosts';
import { DEFAULT_KEYS, sanitizeBindings, type KeyBindings } from './keys';
import { clampSpeed, roundSpeed } from './speed';

export interface Settings {
  /** KeyboardEvent.code per action; null = no key. */
  keys: KeyBindings;
  /** Added/removed by the faster/slower keys and the −/+ buttons. */
  step: number;
  /** Target of the "toggle preferred speed" key. */
  preferredSpeed: number;
  /** Rewind/advance distance. */
  seekSeconds: number;
  /** Each site keeps its own speed (sites without one start at 1×) instead of one global speed. */
  rememberPerSite: boolean;
  /** Also control <audio> elements. Off by default: many sites use them for UI sounds. */
  includeAudio: boolean;
  /** Show the on-video controller. The V key toggles it per page either way. */
  showController: boolean;
  /** Hostnames where the extension stays inactive (subdomains included). */
  blocklist: string[];
}

export const STEP_MIN = 0.01;
export const STEP_MAX = 2;
export const SEEK_MIN = 1;
export const SEEK_MAX = 600;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  keys: { ...DEFAULT_KEYS },
  step: 0.1,
  preferredSpeed: 1.8,
  seekSeconds: 10,
  rememberPerSite: false,
  includeAudio: false,
  showController: true,
  blocklist: [],
});

function toNumber(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

export function sanitizeStep(value: unknown): number {
  const number = toNumber(value);
  if (number === null) return DEFAULT_SETTINGS.step;
  return Math.min(STEP_MAX, Math.max(STEP_MIN, roundSpeed(number)));
}

export function sanitizePreferredSpeed(value: unknown): number {
  const number = toNumber(value);
  return number === null ? DEFAULT_SETTINGS.preferredSpeed : clampSpeed(number);
}

export function sanitizeSeekSeconds(value: unknown): number {
  const number = toNumber(value);
  if (number === null) return DEFAULT_SETTINGS.seekSeconds;
  return Math.min(SEEK_MAX, Math.max(SEEK_MIN, Math.round(number)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    keys: sanitizeBindings(input.keys),
    step: sanitizeStep(input.step),
    preferredSpeed: sanitizePreferredSpeed(input.preferredSpeed),
    seekSeconds: sanitizeSeekSeconds(input.seekSeconds),
    rememberPerSite: bool(input.rememberPerSite, DEFAULT_SETTINGS.rememberPerSite),
    includeAudio: bool(input.includeAudio, DEFAULT_SETTINGS.includeAudio),
    showController: bool(input.showController, DEFAULT_SETTINGS.showController),
    blocklist: sanitizeBlocklist(input.blocklist),
  };
}
