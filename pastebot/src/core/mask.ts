/**
 * "Mask secrets before prompting" (Free). Finds sensitive values in the text that goes into a
 * prompt and replaces them with stable placeholders: `[EMAIL_1]`, `[API_KEY_2]`, `<HOME>`. The
 * same value always gets the same placeholder within one prompt.
 *
 * Pure: no DOM, no Chrome APIs, no logging. Originals only exist in memory while a prompt is
 * made; the extension stores and copies the masked text. Detection is pattern-based and tuned
 * to avoid false positives (versions, dates, UUIDs, order numbers, hashes, code identifiers):
 * numbers are checked (Luhn for cards, mod-97 for IBANs), keys by their documented prefixes.
 */

export const MASK_CATEGORIES = [
  'apiKey',
  'jwt',
  'privateKey',
  'secret',
  'email',
  'phone',
  'card',
  'iban',
  'ip',
  'homePath',
] as const;
export type MaskCategory = (typeof MASK_CATEGORIES)[number];

export interface MaskCategoryInfo {
  /** Settings label. */
  label: string;
  /** Short name for the review list ("API key"). */
  short: string;
  /** Lower-case noun for running text ("card number"). */
  noun: string;
  /** What it looks like, for settings. */
  example: string;
}

export const MASK_CATEGORY_INFO: Readonly<Record<MaskCategory, MaskCategoryInfo>> = {
  apiKey: { label: 'API keys and tokens', short: 'API key', noun: 'API key', example: 'sk-…, ghp_…, AKIA…, xoxb-…, AIza…, Bearer …' },
  jwt: { label: 'JSON Web Tokens', short: 'JWT', noun: 'JWT', example: 'eyJhbGciOi…' },
  privateKey: { label: 'Private key blocks', short: 'Private key', noun: 'private key', example: '-----BEGIN … PRIVATE KEY-----' },
  secret: { label: 'Passwords and secrets in URLs, logs and config', short: 'Secret', noun: 'secret', example: 'password=…, token=…, api_key=…, user:pass@host' },
  email: { label: 'Email addresses', short: 'Email', noun: 'email', example: 'anna@example.com' },
  phone: { label: 'Phone numbers', short: 'Phone', noun: 'phone number', example: '+1 415 555 0132, (415) 555-0132' },
  card: { label: 'Payment card numbers', short: 'Card', noun: 'card number', example: '4242 4242 4242 4242 (checked with Luhn)' },
  iban: { label: 'IBANs', short: 'IBAN', noun: 'IBAN', example: 'DE89 3704 0044 0532 0130 00 (checksum verified)' },
  ip: { label: 'IP addresses', short: 'IP address', noun: 'IP address', example: '203.0.113.42, 2001:db8::1' },
  homePath: { label: 'Home folder paths', short: 'Home path', noun: 'home path', example: '/Users/anna/, /home/anna/, C:\\Users\\anna\\ → <HOME>' },
};

export function isMaskCategory(value: unknown): value is MaskCategory {
  return typeof value === 'string' && (MASK_CATEGORIES as readonly string[]).includes(value);
}

export interface MaskOptions {
  /** Categories to leave as they are. */
  off?: readonly MaskCategory[];
}

export interface MaskedItem {
  category: MaskCategory;
  /** What replaced the value: `[EMAIL_1]`, `<HOME>`. */
  placeholder: string;
  /** A safe hint of what was replaced (`sk-…9fQ2`, `a…@example.com`). Never the value itself. */
  preview: string;
  /** How many times it was replaced. */
  count: number;
}

export interface MaskResult {
  text: string;
  items: MaskedItem[];
}

/** One-shot masking of a single text. */
export function maskSecrets(text: string, options: MaskOptions = {}): MaskResult {
  const masker = new Masker(options);
  return { text: masker.mask(text), items: masker.items };
}

/** "3 items masked". Counts distinct values, not occurrences. */
export function maskSummary(items: readonly MaskedItem[], verb = 'masked'): string {
  return `${items.length} ${items.length === 1 ? 'item' : 'items'} ${verb}`;
}

/**
 * Masks several texts (the content, the page title, the URL) with one shared mapping, so a value
 * that appears in more than one place gets the same placeholder everywhere.
 */
export class Masker {
  private readonly off: ReadonlySet<MaskCategory>;
  private readonly found = new Map<string, MaskedItem>();
  private readonly counters = new Map<string, number>();

  constructor(options: MaskOptions = {}) {
    this.off = new Set(options.off ?? []);
  }

  mask(text: string): string {
    let result = text;
    for (const rule of RULES) {
      if (!this.off.has(rule.category)) result = this.apply(rule, result);
    }
    return result;
  }

  /** Everything replaced so far, by category (MASK_CATEGORIES order), then in order of discovery. */
  get items(): MaskedItem[] {
    const rank = (item: MaskedItem) => MASK_CATEGORIES.indexOf(item.category);
    return [...this.found.values()].map((item) => ({ ...item })).sort((a, b) => rank(a) - rank(b));
  }

  private apply(rule: Rule, text: string): string {
    let output = '';
    let last = 0;
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const span = valueSpan(match);
      if (!span) continue;
      const [start, end] = span;
      const value = text.slice(start, end);
      if (start < last || PLACEHOLDER.test(value)) continue;
      const hit = rule.check(value, match, text, start);
      if (!hit) continue;
      const stop = start + (hit.length ?? value.length);
      output += text.slice(last, start) + this.placeholderFor(rule, hit);
      last = stop;
    }
    return last === 0 ? text : output + text.slice(last);
  }

  private placeholderFor(rule: Rule, hit: Hit): string {
    const key = `${rule.prefix}\u0000${hit.key}`;
    const existing = this.found.get(key);
    if (existing) {
      existing.count += 1;
      return existing.placeholder;
    }
    let placeholder = HOME_PLACEHOLDER;
    if (rule.prefix !== 'HOME') {
      const next = (this.counters.get(rule.prefix) ?? 0) + 1;
      this.counters.set(rule.prefix, next);
      placeholder = `[${rule.prefix}_${next}]`;
    }
    const item: MaskedItem = { category: rule.category, placeholder, preview: hit.preview, count: 1 };
    this.found.set(key, item);
    return placeholder;
  }
}

// --- Rules ---------------------------------------------------------------------------------

interface Hit {
  /** Normalized value: equal keys share a placeholder. */
  key: string;
  preview: string;
  /** Replace only the first `length` characters of the value (default: all of it). */
  length?: number;
}

interface Rule {
  category: MaskCategory;
  /** Placeholder name: `EMAIL` → `[EMAIL_1]`. `HOME` → `<HOME>`. */
  prefix: string;
  /** Global, with indices (`d`). The value is the first named group of VALUE_GROUPS that matched, else the whole match. */
  pattern: RegExp;
  check(value: string, match: RegExpMatchArray, text: string, start: number): Hit | null;
}

const HOME_PLACEHOLDER = '<HOME>';
/** Something an earlier rule (or an earlier prompt) already put there. */
const PLACEHOLDER = /^(?:\[[A-Z_]+_\d+\]|<HOME>)$/;

/** Named groups that hold the value to replace (the rest of a match is context, e.g. `password=`). */
const VALUE_GROUPS = ['v', 'w', 'q', 'r', 'u'] as const;

function valueSpan(match: RegExpMatchArray): [number, number] | null {
  const indices = (match as RegExpMatchArray & { indices?: RegExpIndicesArray }).indices;
  if (!indices) return null;
  for (const name of VALUE_GROUPS) {
    const group = indices.groups?.[name];
    if (group) return group;
  }
  return indices[0] ?? null;
}

const ELLIPSIS = '…';

function last4(value: string): string {
  return value.slice(-4);
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** Values that stand in for a secret rather than being one: `${TOKEN}`, `<password>`, `****`. */
function isStandIn(value: string): boolean {
  return (
    /^(?:\$\{?[A-Za-z_][\w.]*\}?|%[A-Za-z_]\w*%|<[^>]*>|\{\{[^}]*\}\}|\[[^\]]*\]|[*•x.#_-]+)$/i.test(value) ||
    /^(?:true|false|null|nil|none|undefined|empty|redacted|hidden|masked|secret|password|token|changeme|example|xxx+)$/i.test(value)
  );
}

// Private keys: the whole PEM block (or, when the selection cuts it off, the base64 lines that follow).
const privateKeyRule: Rule = {
  category: 'privateKey',
  prefix: 'PRIVATE_KEY',
  pattern:
    /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?:\r?\n[ \t]*[A-Za-z0-9+/=:, -]{8,})*)/dg,
  check(value, match) {
    const kind = (match[1] ?? '').trim();
    return { key: value.replace(/\s+/g, ''), preview: kind ? `${kind} private key` : 'Private key' };
  },
};

// JWTs: three base64url parts, the first two JSON objects (`{"` = `eyJ`).
const jwtRule: Rule = {
  category: 'jwt',
  prefix: 'JWT',
  pattern: /(?<![\w-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/dg,
  check(value) {
    return { key: value, preview: `eyJ${ELLIPSIS}${last4(value.replace(/\.$/, ''))}` };
  },
};

/** Documented key prefixes, longest first (the preview shows the prefix, never the random part). */
const KEY_PREFIXES = [
  'github_pat_',
  'sk-svcacct-',
  'sk-admin-',
  'sk-proj-',
  'sk-ant-',
  'sk_live_',
  'sk_test_',
  'rk_live_',
  'rk_test_',
  'whsec_',
  'glpat-',
  'xapp-',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxo-',
  'xoxs-',
  'xoxr-',
  'xoxe-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'npm_',
  'AKIA',
  'ASIA',
  'ABIA',
  'ACCA',
  'AIza',
  'hf_',
  'SG.',
  'sk-',
];

const API_KEY_PATTERNS = [
  String.raw`(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}`, // AWS access key id
  String.raw`gh[pousr]_[A-Za-z0-9]{36,251}`, // GitHub classic tokens
  String.raw`github_pat_[A-Za-z0-9_]{22,251}`, // GitHub fine-grained tokens
  String.raw`glpat-[A-Za-z0-9_-]{20,}`, // GitLab
  String.raw`sk-(?:ant-(?:api|admin)\d\d-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, // OpenAI, Anthropic
  String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`, // Stripe secret and restricted keys
  String.raw`whsec_[A-Za-z0-9+/=]{20,}`, // Stripe webhook secrets
  String.raw`xox[abposre]-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`xapp-\d-[A-Za-z0-9-]{10,}`, // Slack app tokens
  String.raw`AIza[0-9A-Za-z_-]{35}`, // Google API keys
  String.raw`npm_[A-Za-z0-9]{36}`, // npm
  String.raw`SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}`, // SendGrid
  String.raw`hf_[A-Za-z0-9]{30,}`, // Hugging Face
];

const apiKeyRule: Rule = {
  category: 'apiKey',
  prefix: 'API_KEY',
  pattern: new RegExp(String.raw`(?<![\w-])(?:${API_KEY_PATTERNS.join('|')})(?![A-Za-z0-9_-])`, 'dg'),
  check(value) {
    const prefix = KEY_PREFIXES.find((candidate) => value.startsWith(candidate)) ?? '';
    const body = value.slice(prefix.length);
    // Random key material has digits or mixed case; CSS classes and identifiers ("sk-fading-circle") don't.
    if (!/\d/.test(body) && !(/[a-z]/.test(body) && /[A-Z]/.test(body))) return null;
    return { key: value, preview: `${prefix}${ELLIPSIS}${last4(value)}` };
  },
};

// `Authorization: Bearer <token>` (any token format) and Basic/Token/Digest credentials.
const bearerRule: Rule = {
  category: 'apiKey',
  prefix: 'TOKEN',
  pattern:
    /\bBearer\s+(?<v>[A-Za-z0-9._~+/-]{12,}=*)|\bAuthorization["']?\s*[:=]\s*["']?(?:Basic|Token|Digest)\s+(?<w>[A-Za-z0-9._~+/-]{8,}=*)/dgi,
  check(value, match) {
    if (!/\d/.test(value) || isStandIn(value)) return null;
    const scheme = match.groups?.v !== undefined ? 'Bearer' : (/(Basic|Token|Digest)\s+\S*$/i.exec(match[0])?.[1] ?? 'Basic');
    return { key: value, preview: `${scheme} ${ELLIPSIS}${value.length >= 16 ? last4(value) : ''}` };
  },
};

// Passwords in URLs: scheme://user:password@host
const urlPasswordRule: Rule = {
  category: 'secret',
  prefix: 'SECRET',
  pattern: /\b(?<scheme>[a-z][a-z0-9+.-]*):\/\/(?<user>[^\s:/@]*):(?<v>[^\s@/]+)@/dgi,
  check(value, match) {
    if (isStandIn(value)) return null;
    return { key: value, preview: `${match.groups?.scheme ?? ''}://${match.groups?.user ?? ''}:${ELLIPSIS}@` };
  },
};

// Keys whose value is a secret. The key must END with one of these words, so `tokens_used=500`
// and `password_hash=...` are left alone.
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signing[_-]?key|auth[_-]?key|credentials?|session[_-]?id|sessionid|sessid)`;

const secretAssignmentRule: Rule = {
  category: 'secret',
  prefix: 'SECRET',
  pattern: new RegExp(
    String.raw`(?<![A-Za-z0-9_.-])(?<k>${SECRET_KEY})["']?(?:=(?<v>[^\s&"'<>;,(){}\[\]]+)|[ \t]*[:=][ \t]*(?:"(?<q>[^"\n]*)"|'(?<r>[^'\n]*)'|(?<u>[^\s"',;(){}\[\]<>]+)))`,
    'dgi',
  ),
  check(value, match) {
    const groups = match.groups ?? {};
    if (value.length < 3 || isStandIn(value)) return null;
    if (groups.q !== undefined || groups.r !== undefined) {
      // A quoted sentence is a message ("must be 8 characters"), not a secret.
      if ((value.match(/\s/g) ?? []).length >= 3) return null;
    } else if (groups.u !== undefined) {
      // `password: hunter2` yes; `token: this.token`, `password: getPassword` no.
      if (value.length < 4 || !/[\d!@#$%^&*+=?~]/.test(value)) return null;
    }
    const key = match.groups?.k ?? 'secret';
    return { key: value, preview: `${key}=${ELLIPSIS}${value.length >= 16 ? last4(value) : ''}` };
  },
};

/** Extensions that look like TLDs in `icon@2x.png`, `logo@3x.webp`, `pkg@latest.js`. */
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'json', 'map', 'html', 'htm', 'vue', 'lock', 'wasm',
]);

const emailRule: Rule = {
  category: 'email',
  prefix: 'EMAIL',
  pattern:
    /(?<![\w.%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])/dg,
  check(value) {
    const at = value.lastIndexOf('@');
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
    // git@github.com:org/repo.git is an SSH address, not a person.
    if (FILE_EXTENSIONS.has(tld) || local.toLowerCase() === 'git') return null;
    return { key: value.toLowerCase(), preview: `${local[0] ?? ''}${ELLIPSIS}@${domain}` };
  },
};

/** IBAN length per country (ISO 13616 registry). */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24,
  SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function isValidIban(iban: string): boolean {
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact) || IBAN_LENGTHS[compact.slice(0, 2)] !== compact.length) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const ibanRule: Rule = {
  category: 'iban',
  prefix: 'IBAN',
  pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/dg,
  check(value) {
    const length = IBAN_LENGTHS[value.slice(0, 2)];
    if (!length) return null;
    // The match may run into a following word ("… 0130 00 TEST"): take exactly `length` characters.
    let taken = 0;
    let end = 0;
    while (end < value.length && taken < length) {
      if (value[end] !== ' ') taken += 1;
      end += 1;
    }
    if (taken < length || (end < value.length && value[end] !== ' ')) return null;
    const iban = value.slice(0, end).replace(/ /g, '');
    if (!isValidIban(iban)) return null;
    return { key: iban, preview: `${iban.slice(0, 2)}${ELLIPSIS}${last4(iban)}`, length: end };
  },
};

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Visa, Mastercard, Amex, Discover, Diners, JCB, UnionPay, Maestro. Timestamps and most IDs start elsewhere. */
const CARD_PREFIX = /^(?:4|5\d|2[2-7]|3[04-8]|6)/;

const cardRule: Rule = {
  category: 'card',
  prefix: 'CARD',
  pattern: /(?<![\w.,+-])\d(?:[ -]?\d){12,18}(?![\w-]|[.,]\d)/dg,
  check(value) {
    const separators = value.replace(/\d/g, '');
    if (separators && !/^(?: +|-+)$/.test(separators)) return null;
    if (separators) {
      const groups = value.split(separators[0] ?? ' ');
      // 4-4-4-4, 4-6-5 (Amex), 4-6-4 (Diners), 4-4-4-4-3: never "4 1 1 1 …" or a date glued to a number.
      if (groups[0]?.length !== 4 || groups.some((group) => group.length < 3)) return null;
    }
    const digits = digitsOf(value);
    if (digits.length < 13 || digits.length > 19 || !CARD_PREFIX.test(digits) || !passesLuhn(digits)) return null;
    return { key: digits, preview: `${ELLIPSIS}${last4(digits)}` };
  },
};

function phoneHit(value: string, min: number): Hit | null {
  const digits = digitsOf(value);
  if (digits.length < min || digits.length > 15) return null;
  return { key: `${value.trim().startsWith('+') ? '+' : ''}${digits}`, preview: `${ELLIPSIS}${last4(digits)}` };
}

const phoneRules: Rule[] = [
  {
    // International: +1 (415) 555-0132, +44 20 7946 0958, +380671234567.
    category: 'phone',
    prefix: 'PHONE',
    pattern: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,5}\)?){1,6}(?![\w-]|[.,]\d)/dg,
    check: (value) => phoneHit(value, 8),
  },
  {
    // North American: (415) 555-0132, 415-555-0132, 415.555.0132 (area and exchange start with 2-9).
    category: 'phone',
    prefix: 'PHONE',
    pattern: /(?<![\w.+-])(?:\( ?[2-9]\d{2} ?\) ?|[2-9]\d{2}[-.])[2-9]\d{2}[-.]\d{4}(?![\w-]|[.,]\d)/dg,
    check: (value) => phoneHit(value, 10),
  },
  {
    // Labelled: "Phone: 020 7946 0958", "tel. 067 123 45 67".
    category: 'phone',
    prefix: 'PHONE',
    pattern:
      /\b(?:phone|telephone|tel|mobile|cell|fax|whatsapp)\b\.?(?:\s*(?:number|no\.?|#))?\s*[:=]?\s*(?<v>\+?\(?\d[\d ().-]{5,20}\d)/dgi,
    check: (value) => (/^\d{4}-\d{2}-\d{2}/.test(value) ? null : phoneHit(value, 7)),
  },
];

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;

const ipv6Rule: Rule = {
  category: 'ip',
  prefix: 'IP',
  pattern: /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:]|\.\d)/dg,
  check(value) {
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
    const groups = halves.length === 2 ? [...groupsOf(halves[0] ?? ''), ...groupsOf(halves[1] ?? '')] : groupsOf(value);
    if (halves.length === 2 ? groups.length > 7 : groups.length !== 8) return null;
    if (groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) return null;
    // Not ::1 / :: and not a::b-like identifiers: at least two groups, one of them 3+ digits long.
    if (groups.length < 2 || !groups.some((group) => group.length >= 3)) return null;
    return { key: value.toLowerCase(), preview: `${groups[0]}:${ELLIPSIS}` };
  },
};

const ipv4Rule: Rule = {
  category: 'ip',
  prefix: 'IP',
  pattern: new RegExp(String.raw`(?<![\w.])${OCTET}(?:\.${OCTET}){3}(?!\w|\.\d)`, 'dg'),
  check(value, _match, text, start) {
    const first = Number(value.split('.')[0]);
    // 0.x (unspecified), 127.x (loopback) and 255.x (netmasks) say nothing about anyone.
    if (first === 0 || first === 127 || first === 255) return null;
    // "version 1.0.0.1", "v2.3.0.1", "build 10.0.1.2" are versions, not addresses.
    if (/(?:\bv|\bver\.?|\bversion|\brelease|\bbuild)\s*$/i.test(text.slice(Math.max(0, start - 12), start))) return null;
    return { key: value, preview: `${first}.${ELLIPSIS}` };
  },
};

const homePathRule: Rule = {
  category: 'homePath',
  prefix: 'HOME',
  pattern:
    /(?:(?<![\w.~-])(?:\/Users\/|\/home\/)[^/\s:'"`<>|]+|(?<!\w)[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s:'"`<>|]+)(?=[\\/:]|$)/dgm,
  check(value) {
    const name = value.split(/[\\/]+/).pop() ?? '';
    if (!name || /^[$%~]/.test(name) || /^(?:shared|public|default|all users|default user)$/i.test(name)) return null;
    return { key: 'home', preview: `${value.slice(0, value.length - name.length)}${name[0] ?? ''}${ELLIPSIS}` };
  },
};

/**
 * Order matters: specific formats first, so `token=eyJ…` becomes `token=[JWT_1]` and a card
 * number inside an IBAN is never seen as a card.
 */
const RULES: readonly Rule[] = [
  privateKeyRule,
  jwtRule,
  apiKeyRule,
  bearerRule,
  urlPasswordRule,
  secretAssignmentRule,
  emailRule,
  ibanRule,
  cardRule,
  ...phoneRules,
  ipv6Rule,
  ipv4Rule,
  homePathRule,
];
