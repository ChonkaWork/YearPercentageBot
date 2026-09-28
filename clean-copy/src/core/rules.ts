/**
 * Custom cleanup rules (Pro): ordered find/replace steps applied after the built-in cleanup.
 *
 * A rule finds plain text or a regular expression. User regexes run inside web pages on
 * every copy, so the engine is defensive:
 * - patterns are validated before they are used (syntax, length, and the classic
 *   catastrophic-backtracking shapes such as `(a+)+` or `(.*)*`)
 * - matching is done one match at a time, and the whole run has a time budget and a match
 *   cap, checked between matches; when either is hit the remaining work is skipped and the
 *   result says so
 * - the input and the output have size limits
 *
 * A single `RegExp.exec` call can't be interrupted in JavaScript, so validation is what keeps
 * one pathological match from hanging a page; the budget bounds everything else.
 * Pure: no DOM, no Chrome APIs.
 */

export type RuleMode = 'text' | 'regex';

export interface Rule {
  id: string;
  enabled: boolean;
  mode: RuleMode;
  find: string;
  /** `\n`, `\t` and `\\` are escapes in both modes; regex mode also has $1, $<name>, $&, $$. */
  replace: string;
  caseSensitive: boolean;
}

export const RULE_LIMITS = {
  maxRules: 50,
  maxFindLength: 500,
  maxReplaceLength: 1000,
  /** Text longer than this is copied without custom rules (built-in cleanup still runs). */
  maxInputLength: 1_000_000,
  /** The result may grow (replacements longer than matches), up to this size. */
  maxOutputLength: 2_000_000,
  maxMatches: 100_000,
  timeBudgetMs: 150,
} as const;

export type RuleError =
  | 'empty'
  | 'too-long'
  | 'replace-too-long'
  | 'invalid-regex'
  | 'unsafe-regex'
  | 'unknown-group';

export type Validation = { ok: true } | { ok: false; error: RuleError; message: string };

const MESSAGES: Record<RuleError, string> = {
  empty: 'Enter the text to find.',
  'too-long': `Keep "Find" under ${RULE_LIMITS.maxFindLength} characters.`,
  'replace-too-long': `Keep "Replace with" under ${RULE_LIMITS.maxReplaceLength} characters.`,
  'invalid-regex': 'This is not a valid regular expression.',
  'unsafe-regex':
    'This pattern can take forever on some text (a repeated group that itself repeats, like (a+)+). Rewrite it without the nested repetition.',
  'unknown-group': 'The replacement refers to a group the pattern does not have.',
};

function fail(error: RuleError, detail?: string): Validation {
  return { ok: false, error, message: detail ? `${MESSAGES[error]} ${detail}` : MESSAGES[error] };
}

export function regexFlags(rule: Pick<Rule, 'caseSensitive'>): string {
  // g: every match; m: ^ and $ work per line, which is what people expect for text.
  return rule.caseSensitive ? 'gm' : 'gim';
}

export function validateRule(rule: Pick<Rule, 'mode' | 'find' | 'replace' | 'caseSensitive'>): Validation {
  if (rule.find.length === 0) return fail('empty');
  if (rule.find.length > RULE_LIMITS.maxFindLength) return fail('too-long');
  if (rule.replace.length > RULE_LIMITS.maxReplaceLength) return fail('replace-too-long');
  if (rule.mode === 'text') return { ok: true };

  let regex: RegExp;
  try {
    regex = new RegExp(rule.find, regexFlags(rule));
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '') : '';
    return fail('invalid-regex', reason ? `(${reason})` : undefined);
  }
  if (isUnsafePattern(rule.find)) return fail('unsafe-regex');
  const groups = countGroups(regex);
  const names = namedGroups(rule.find);
  for (const ref of replacementRefs(rule.replace)) {
    if (typeof ref === 'number' ? ref > groups : !names.has(ref)) return fail('unknown-group');
  }
  return { ok: true };
}

function countGroups(regex: RegExp): number {
  // An alternative that always matches the empty string reveals the group count.
  const probe = new RegExp(`${regex.source}|`, '');
  return (probe.exec('')?.length ?? 1) - 1;
}

function namedGroups(source: string): Set<string> {
  return new Set([...source.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((match) => match[1] ?? ''));
}

/** Group references in a replacement: numbers for $1..$99, names for $<name>. */
function replacementRefs(replace: string): (number | string)[] {
  const refs: (number | string)[] = [];
  for (let i = 0; i < replace.length; i++) {
    if (replace[i] !== '$') continue;
    const next = replace[i + 1];
    if (next === '$' || next === '&') {
      i++;
      continue;
    }
    const numbered = /^\d{1,2}/.exec(replace.slice(i + 1));
    if (numbered) {
      const value = Number(numbered[0]);
      if (value > 0) refs.push(value);
      i += numbered[0].length;
      continue;
    }
    const named = /^<([^>]*)>/.exec(replace.slice(i + 1));
    if (named) {
      refs.push(named[1] ?? '');
      i += named[0].length;
    }
  }
  return refs;
}

/**
 * Detects the patterns that backtrack exponentially: a quantified group whose body can
 * itself repeat (`(a+)+`, `(\w*\s?)*`, `(?:x|y+){2,}`), and a quantified group of
 * alternatives where one alternative is a prefix of another (`(a|ab)*`, `(a|a)+`).
 * A heuristic: it rejects the well-known shapes, not every slow pattern.
 */
export function isUnsafePattern(source: string): boolean {
  interface Frame {
    /** The body contains something that can match a varying amount (*, +, ?, {n,m}). */
    variable: boolean;
    alternatives: string[];
    current: string;
  }
  const stack: Frame[] = [];
  let top: Frame = { variable: false, alternatives: [], current: '' };
  let inClass = false;

  /** The quantifier starting at `index`, if any: its length and whether it repeats. */
  const quantifierAt = (index: number): { length: number; repeats: boolean; variable: boolean } | null => {
    const match = /^(?:([*+?])|\{(\d+)(,(\d*))?\})\??/.exec(source.slice(index));
    if (!match) return null;
    const [text, symbol, min, comma, max] = match;
    if (symbol) return { length: text.length, repeats: symbol !== '?', variable: true };
    const low = Number(min);
    const high = comma === undefined ? low : max === '' || max === undefined ? Infinity : Number(max);
    return { length: text.length, repeats: high > 1, variable: high !== low };
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? '';
    if (char === '\\') {
      top.current += source.slice(i, i + 2);
      i++;
      continue;
    }
    if (inClass) {
      top.current += char;
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      top.current += char;
      continue;
    }
    if (char === '(') {
      stack.push(top);
      top = { variable: false, alternatives: [], current: '' };
      // Skip the group prefix: (?:, (?=, (?!, (?<=, (?<!, (?<name>
      const prefix = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(i));
      if (prefix) i += prefix[0].length - 1;
      continue;
    }
    if (char === '|') {
      top.alternatives.push(top.current);
      top.current = '';
      continue;
    }
    if (char === ')') {
      const group = top;
      group.alternatives.push(group.current);
      const parent = stack.pop();
      if (!parent) return false; // Unbalanced: the RegExp constructor reports it.
      top = parent;
      const quantifier = quantifierAt(i + 1);
      if (quantifier?.repeats && (group.variable || overlappingAlternatives(group.alternatives))) return true;
      top.current += `(${group.alternatives.join('|')})`;
      if (group.variable || quantifier?.variable) top.variable = true;
      if (quantifier) {
        top.current += source.slice(i + 1, i + 1 + quantifier.length);
        i += quantifier.length;
      }
      continue;
    }
    const quantifier = quantifierAt(i);
    if (quantifier) {
      if (quantifier.variable) top.variable = true;
      top.current += source.slice(i, i + quantifier.length);
      i += quantifier.length - 1;
      continue;
    }
    top.current += char;
  }
  return false;
}

function overlappingAlternatives(alternatives: string[]): boolean {
  if (alternatives.length < 2) return false;
  for (let a = 0; a < alternatives.length; a++) {
    for (let b = 0; b < alternatives.length; b++) {
      if (a === b) continue;
      const first = alternatives[a] ?? '';
      const second = alternatives[b] ?? '';
      // Only literal alternatives can be compared reliably.
      if (!/^[^\\[\]().*+?{}^$]*$/.test(first) || !/^[^\\[\]().*+?{}^$]*$/.test(second)) continue;
      if (first === '' || second.startsWith(first)) return true;
    }
  }
  return false;
}

// --- Replacement templates ------------------------------------------------------------------

/** `\n`, `\t`, `\\` escapes (both modes). Any other backslash stays as typed. */
export function unescapeReplacement(value: string): string {
  return value.replace(/\\([nt\\])/g, (_, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : '\\'));
}

function expandTemplate(template: string, match: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char !== '$') {
      out += char;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i++;
      continue;
    }
    if (next === '&') {
      out += match[0];
      i++;
      continue;
    }
    const numbered = /^\d{1,2}/.exec(template.slice(i + 1));
    if (numbered) {
      // $12 means group 12 when it exists, otherwise group 1 followed by "2".
      let digits = numbered[0];
      if (digits.length === 2 && Number(digits) >= match.length) digits = digits.slice(0, 1);
      const index = Number(digits);
      if (index > 0 && index < match.length) {
        out += match[index] ?? '';
        i += digits.length;
        continue;
      }
    }
    const named = /^<([^>]*)>/.exec(template.slice(i + 1));
    if (named && match.groups && named[1] !== undefined && named[1] in match.groups) {
      out += match.groups[named[1]] ?? '';
      i += named[0].length;
      continue;
    }
    out += '$';
  }
  return out;
}

// --- Engine ---------------------------------------------------------------------------------

export interface RuleRunOptions {
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  timeBudgetMs?: number;
  maxMatches?: number;
}

export type RuleStop = 'time' | 'matches' | 'output' | 'input';

export interface RuleRunResult {
  text: string;
  /** Replacements made. */
  replacements: number;
  /** Rules that changed the text. */
  rulesApplied: number;
  /** Rules skipped because they are disabled or invalid. */
  skipped: number;
  /** Set when a limit stopped the run early; the text holds whatever was done until then. */
  stopped?: RuleStop;
}

export function applyRules(input: string, rules: readonly Rule[], options: RuleRunOptions = {}): RuleRunResult {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const budget = options.timeBudgetMs ?? RULE_LIMITS.timeBudgetMs;
  const maxMatches = options.maxMatches ?? RULE_LIMITS.maxMatches;
  const result: RuleRunResult = { text: input, replacements: 0, rulesApplied: 0, skipped: 0 };
  const active = rules.slice(0, RULE_LIMITS.maxRules);
  result.skipped += rules.length - active.length;
  if (active.length === 0) return result;
  if (input.length > RULE_LIMITS.maxInputLength) {
    result.stopped = 'input';
    return result;
  }

  const started = now();
  let matches = 0;
  let text = input;

  for (const rule of active) {
    if (!rule.enabled || !validateRule(rule).ok) {
      result.skipped++;
      continue;
    }
    const regex =
      rule.mode === 'regex' ? new RegExp(rule.find, regexFlags(rule)) : new RegExp(escapeRegExp(rule.find), rule.caseSensitive ? 'g' : 'gi');
    const replacement = unescapeReplacement(rule.replace);
    let out = '';
    let last = 0;
    let changed = false;
    let stop: RuleStop | undefined;
    regex.lastIndex = 0;

    for (;;) {
      const match = regex.exec(text);
      if (!match) break;
      if (++matches > maxMatches) {
        stop = 'matches';
        break;
      }
      const piece = rule.mode === 'regex' ? expandTemplate(replacement, match) : replacement;
      out += text.slice(last, match.index) + piece;
      last = match.index + match[0].length;
      if (piece !== match[0]) changed = true;
      result.replacements++;
      if (match[0].length === 0) regex.lastIndex++;
      if (out.length > RULE_LIMITS.maxOutputLength) {
        stop = 'output';
        break;
      }
      if (now() - started > budget) {
        stop = 'time';
        break;
      }
    }

    if (stop === 'output') {
      // Don't keep a half-grown text: this rule is dropped entirely.
      result.stopped = stop;
      break;
    }
    text = out + text.slice(last);
    if (changed) result.rulesApplied++;
    if (stop) {
      result.stopped = stop;
      break;
    }
    if (now() - started > budget) {
      result.stopped = 'time';
      break;
    }
  }
  result.text = text;
  return result;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Storage --------------------------------------------------------------------------------

export function newRuleId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyRule(id = newRuleId()): Rule {
  return { id, enabled: true, mode: 'text', find: '', replace: '', caseSensitive: false };
}

/** Accepts anything read from storage; drops malformed entries, clamps lengths and count. */
export function sanitizeRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const item of raw) {
    if (rules.length >= RULE_LIMITS.maxRules) break;
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    let id = typeof value.id === 'string' && /^[\w-]{1,40}$/.test(value.id) ? value.id : newRuleId();
    while (seen.has(id)) id = newRuleId();
    seen.add(id);
    rules.push({
      id,
      enabled: value.enabled !== false,
      mode: value.mode === 'regex' ? 'regex' : 'text',
      find: typeof value.find === 'string' ? value.find.slice(0, RULE_LIMITS.maxFindLength) : '',
      replace: typeof value.replace === 'string' ? value.replace.slice(0, RULE_LIMITS.maxReplaceLength) : '',
      caseSensitive: value.caseSensitive === true,
    });
  }
  return rules;
}
