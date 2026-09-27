import { isUiNoise } from './noise';
import type { ContentInfo } from './types';

/**
 * Lightweight, local content detection. It only has to be good enough to pick a better
 * prompt template ("Explain the following Java error" instead of "Explain the following
 * content"), so every rule errs on the side of returning plain `text`: a generic prompt
 * is fine, a confidently wrong one is not.
 */

/** Detection only looks at the beginning of very large inputs. */
const SAMPLE_CHARS = 20_000;
const SAMPLE_LINES = 400;

interface LanguageRule {
  name: string;
  patterns: RegExp[];
  /** Scores of the named rule are added when this rule matched on its own (TypeScript ⊃ JavaScript). */
  extends?: string;
}

// ---------------------------------------------------------------------------------------
// Errors and stack traces
// ---------------------------------------------------------------------------------------

const STRONG_ERROR_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /^Exception in thread "/m,
  /^panic: /m,
  /\berror\[E\d{4}\]/,
  /thread '[^']*' panicked at/,
  /^\s*(?:PHP )?(?:Fatal error|Parse error|Uncaught \w+):/m,
  /\bSegmentation fault\b/,
  /^npm ERR! /m,
  /^(?:error|fatal|Error|ERROR|FATAL): \S/m,
  // Compiler output: "main.c:3:5: error: ...", "src/index.ts:12:5 - error TS2345: ..."
  /^\S+:\d+(?::\d+)?:?\s+(?:-\s+)?(?:fatal )?error\b/m,
  /\berror TS\d{4}\b/,
  // "TypeError: x is not a function", "NullPointerException at Foo.java:12", "java.lang.IllegalStateException: ..."
  /^\s*(?:Uncaught |Caused by: )?(?:[a-z_$][\w$]*\.)*[A-Z][\w$]*(?:Error|Exception)\b(?::|\s+at\s|\s*$)/m,
];

const STACK_FRAME = /^\s*at\s+\S.*(?::\d+(?::\d+)?\)?|\(Native Method\)|\(Unknown Source\))\s*$/gm;
const PYTHON_FRAME = /^\s*File "[^"]+", line \d+/gm;
const EXCEPTION_NAME = /\b[A-Z][\w$]*(?:Error|Exception)\b/;
const FILE_LINE = /\b[\w-]+\.(?:java|kt|py|m?js|cjs|jsx|tsx?|go|rs|cs|php|rb|cpp|cc|cxx|hpp|c|h|swift|scala):(?:line )?\d+/;

const ERROR_LANGUAGE_RULES: LanguageRule[] = [
  { name: 'Java', patterns: [/\.java:\d+/, /\bjava\.(?:lang|util|io|net|sql)\./, /Exception in thread "/, /\bat (?:[a-z_$][\w$]*\.)+[\w$<>]+\([\w$]+\.java/] },
  { name: 'Kotlin', patterns: [/\.kt:\d+/, /\bkotlin\.\w+/] },
  { name: 'Python', patterns: [/Traceback \(most recent call last\)/, /File "[^"]+\.py", line \d+/, /\.py:\d+/] },
  { name: 'TypeScript', patterns: [/\.tsx?:\d+/, /\berror TS\d{4}\b/] },
  { name: 'JavaScript', patterns: [/\.(?:m?js|cjs|jsx):\d+/, /\bUncaught \w+/, /at Object\.<anonymous>/, /\bnode:internal\//] },
  { name: 'Go', patterns: [/^panic: /m, /^goroutine \d+ \[/m, /\.go:\d+/] },
  { name: 'Rust', patterns: [/\berror\[E\d{4}\]/, /\.rs:\d+/, /thread '[^']*' panicked/] },
  { name: 'C#', patterns: [/\.cs:line \d+/, /\bSystem\.\w+Exception\b/] },
  { name: 'PHP', patterns: [/\bPHP (?:Fatal error|Warning|Notice|Parse error)/, /\.php(?::\d+| on line \d+)/] },
  { name: 'Ruby', patterns: [/\.rb:\d+/] },
  { name: 'C++', patterns: [/\.(?:cpp|cc|cxx|hpp|hh):\d+/, /\bstd::\w+/] },
  { name: 'C', patterns: [/\.[ch]:\d+:\d+/, /\bSegmentation fault\b/] },
  { name: 'Swift', patterns: [/\.swift:\d+/] },
];

// ---------------------------------------------------------------------------------------
// Source code
// ---------------------------------------------------------------------------------------

/** Signals that a single line is code rather than prose. */
const CODE_LINE_PATTERNS: RegExp[] = [
  /[;{}]\s*$/,
  /^\s*[}\])]/,
  /^\s*(?:import\s+[\w{*"']|from\s+[\w.]+\s+import\s|export\s+(?:default|const|function|class|interface|type)\b|package\s+[\w.]+|using\s+[\w.]+;|#include\b|#define\b|def\s+\w+\s*\(|class\s+[A-Z]\w*\s*(?:[({:<]|extends\b|implements\b|$)|(?:public|private|protected|internal)\s+(?:(?:static|final|abstract|async|override|readonly)\s+)*[\w<>[\],.?]+\s+\w+\s*[(=;{]|function\s*\w*\s*\(|(?:const|let|var|val)\s+[\w{[]+\s*[:=]|func\s+\w|fn\s+\w+|impl\b|struct\s+\w+|enum\s+\w+|interface\s+\w+|return\b.*;\s*$|(?:if|for|while|switch|catch)\s*\(|else\s*(?:\{|:|if\b)|try\s*[{:]|@[A-Z]\w*(?:\(.*\))?\s*$)/,
  /^\s*(?:if|elif|else|for|while|with|try|except|finally|def|class)\b.*:\s*$/,
  /^\s+return\b/,
  /^\s*[a-z_$][\w.$]*(?:\[[^\]]*\])?\s*[+\-*/]?=\s*[^=\s]/,
  /(?:=>|===?|!==?|&&|\|\||::|:=|\+=|-=)/,
  /^\s*(?:\/\/|\/\*|\*\/|#!)/,
  /^\s*<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/,
  /\b\w+\([^()]*\)\s*;?\s*$/,
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s/,
];

const CODE_LANGUAGE_RULES: LanguageRule[] = [
  { name: 'Java', patterns: [/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],]+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{/, /\bSystem\.(?:out|err)\.print/, /^\s*import\s+java[x]?\./m, /@Override\b/, /\bpublic\s+(?:final\s+)?class\s+\w+/, /\bString\[\]\s+args\b/] },
  { name: 'Kotlin', patterns: [/\bfun\s+\w+\s*\(/, /^\s*val\s+\w+\s*[:=]/m, /\bdata\s+class\b/, /\bprintln\(/] },
  { name: 'Python', patterns: [/^\s*def\s+\w+\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$/m, /^\s*(?:from\s+[\w.]+\s+)?import\s+[\w., ]+$/m, /\bself\.\w+/, /^\s*elif\b/m, /^\s*class\s+\w+(?:\(.*\))?:\s*$/m, /\bprint\(/, /^\s*if __name__ == ['"]__main__['"]:/m, /^\s*for\s+\w+(?:\s*,\s*\w+)*\s+in\s+.+:\s*$/m, /^\s*(?:if|elif|while)\s+[^(].*:\s*$/m] },
  { name: 'JavaScript', patterns: [/\b(?:const|let|var)\s+[\w{[][^=]*=/, /=>/, /\bfunction\s*\w*\s*\(/, /\bconsole\.\w+\(/, /\brequire\(['"]/, /\bimport\s+.+\s+from\s+['"]/, /\bexport\s+(?:default|const|function|class)\b/, /\bdocument\.\w+/] },
  { name: 'TypeScript', extends: 'JavaScript', patterns: [/:\s*(?:string|number|boolean|void|unknown|any|never)(?:\[\])?\s*[,)=;{|]/, /\binterface\s+\w+\s*(?:<[^>]*>)?\s*(?:extends\s+[\w, <>.]+)?\{/, /^\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=/m, /\bas\s+const\b/, /\bimport\s+type\b/, /\b(?:private|public|readonly)\s+\w+\s*:/] },
  { name: 'Go', patterns: [/^package\s+\w+\s*$/m, /\bfunc\s+(?:\([^)]*\)\s*)?\w+\s*\(/, /\w+\s*:=\s*/, /\bfmt\.\w+\(/, /\berr\s*!=\s*nil\b/] },
  { name: 'Rust', patterns: [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/, /\blet\s+mut\b/, /\bimpl\b(?:\s*<[^>]*>)?\s+\w+/, /\b(?:println|vec|format|panic)!\(/, /\bpub\s+(?:fn|struct|enum|mod)\b/, /->\s*(?:Result|Option|Self|&?str|i32|i64|u\d+|usize|bool|String)\b/] },
  { name: 'C#', patterns: [/^\s*using\s+System(?:\.[\w.]+)?;/m, /^\s*namespace\s+[\w.]+/m, /\bConsole\.Write(?:Line)?\(/, /\bpublic\s+(?:async\s+)?Task\b/, /\{\s*get;\s*(?:set;\s*)?\}/] },
  { name: 'C', patterns: [/#include\s*<(?:stdio|stdlib|string|unistd)\.h>/, /\bprintf\s*\(/, /\bmalloc\s*\(/, /\bint\s+main\s*\(/] },
  { name: 'C++', extends: 'C', patterns: [/#include\s*<(?:iostream|vector|string|memory|map|algorithm)>/, /\bstd::\w+/, /\bcout\s*<</, /\btemplate\s*<\s*(?:typename|class)/] },
  { name: 'PHP', patterns: [/<\?php/, /\$\w+\s*=[^=]/, /\$this->\w+/, /\bfunction\s+\w+\s*\([^)]*\$\w+/] },
  { name: 'Ruby', patterns: [/^\s*def\s+\w+[?!]?(?:\(.*\))?\s*$/m, /^\s*end\s*$/m, /\bputs\s+/, /\bdo\s*\|\w+\|/, /^\s*require\s+['"]/m] },
  { name: 'SQL', patterns: [/\bSELECT\b[\s\S]+?\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bCREATE\s+(?:TABLE|INDEX|VIEW)\b/i, /\b(?:INNER|LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b/i, /\bGROUP\s+BY\b/i, /\bWHERE\b/] },
  { name: 'Shell', patterns: [/^\s*\$\s+\w+/m, /^\s*(?:sudo|apt(?:-get)?|brew|npm|npx|yarn|pnpm|pip3?|git|docker|kubectl|curl|wget|mkdir|chmod|export)\s+\S/m, /^#!\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z)?sh/m] },
  { name: 'HTML', patterns: [/<!DOCTYPE html>/i, /<\/?(?:html|head|body|div|span|section|nav|ul|li|p|a|button|form|input|script|style)\b[^>]*>/i] },
  { name: 'CSS', patterns: [/^\s*[.#]?[\w-][\w\s,.#:>*()[\]="'-]*\{\s*$/m, /^\s*(?:color|background(?:-color)?|margin|padding|display|font-(?:size|family|weight)|border|width|height|position|flex|grid|z-index)\s*:\s*[^;]+;/m] },
];

// ---------------------------------------------------------------------------------------

export function detectContent(text: string): ContentInfo {
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  // UI labels ("Share", "Copy code") say nothing about the content, so they don't count.
  const lines = sample
    .split('\n')
    .filter((line) => line.trim() !== '' && !isUiNoise(line))
    .slice(0, SAMPLE_LINES);
  const nonLatin = isMostlyNonLatin(sample);

  if (lines.length === 0) return { kind: 'text', nonLatin };

  if (!isMostlyProse(lines) && looksLikeError(sample)) {
    const language = pickLanguage(sample, ERROR_LANGUAGE_RULES, { minScore: 1, firstWinsOnTie: true });
    return withLanguage({ kind: 'error', nonLatin }, language);
  }
  if (looksLikeJson(sample)) return { kind: 'code', language: 'JSON', nonLatin };
  if (looksLikeCode(lines)) {
    const language = pickLanguage(sample, CODE_LANGUAGE_RULES, { minScore: 2, firstWinsOnTie: false });
    return withLanguage({ kind: 'code', nonLatin }, language);
  }
  if (looksLikeTable(lines)) return { kind: 'table', nonLatin };
  return { kind: 'text', nonLatin };
}

function withLanguage(info: ContentInfo, language: string | undefined): ContentInfo {
  return language ? { ...info, language } : info;
}

function looksLikeError(sample: string): boolean {
  if (STRONG_ERROR_PATTERNS.some((re) => re.test(sample))) return true;
  if (countMatches(sample, STACK_FRAME) >= 2 || countMatches(sample, PYTHON_FRAME) >= 1) return true;
  return EXCEPTION_NAME.test(sample) && FILE_LINE.test(sample);
}

function looksLikeJson(sample: string): boolean {
  const trimmed = sample.trim();
  const wrapped =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!wrapped || trimmed.length < 2) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function isCodeLine(line: string): boolean {
  return CODE_LINE_PATTERNS.some((re) => re.test(line));
}

function codeSignalCount(line: string): number {
  return CODE_LINE_PATTERNS.reduce((count, re) => count + (re.test(line) ? 1 : 0), 0);
}

function looksLikeCode(lines: string[]): boolean {
  if (lines.length === 1) return codeSignalCount(lines[0] ?? '') >= 2;
  if (isMostlyProse(lines)) return false;
  const codeLines = lines.filter(isCodeLine).length;
  const indented = lines.filter((line) => /^(?: {2,}|\t)\S/.test(line)).length;
  const ratio = codeLines / lines.length;
  return ratio >= 0.5 || (ratio >= 0.3 && indented / lines.length >= 0.25);
}

/** Lines that read like sentences: several words and sentence punctuation at the end. */
function isMostlyProse(lines: string[]): boolean {
  if (lines.length < 3) return false;
  const prose = lines.filter(
    (line) => line.trim().split(/\s+/).length >= 8 && /[.!?…:]["'”»)\]]?\s*$/.test(line) && !/[;{}]\s*$/.test(line),
  ).length;
  return prose / lines.length >= 0.5;
}

function looksLikeTable(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const tabRows = lines.filter((line) => /\S\t/.test(line.replace(/^\s+/, ''))).length;
  if (tabRows >= 2 && tabRows / lines.length >= 0.5) return true;
  const markdownSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  const pipeRows = lines.filter((line) => line.includes('|')).length;
  return lines.some((line) => markdownSeparator.test(line)) && pipeRows >= 3;
}

/**
 * Picks the language whose patterns match most often. Returns undefined when the best
 * score is below `minScore` or tied, so an ambiguous snippet stays "code".
 * Ties between error rules resolve to the first rule (those patterns are very specific).
 */
function pickLanguage(
  sample: string,
  rules: LanguageRule[],
  options: { minScore: number; firstWinsOnTie: boolean },
): string | undefined {
  const { minScore } = options;
  const own = new Map<string, number>();
  for (const rule of rules) {
    own.set(rule.name, rule.patterns.filter((re) => re.test(sample)).length);
  }
  const scored = rules.map((rule) => {
    const base = own.get(rule.name) ?? 0;
    const inherited = rule.extends && base > 0 ? (own.get(rule.extends) ?? 0) : 0;
    return { name: rule.name, score: base + inherited };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < minScore) return undefined;
  const tied = scored.filter((entry) => entry.score === best.score).length > 1;
  if (tied && !options.firstWinsOnTie) return undefined;
  return best.name;
}

function isMostlyNonLatin(sample: string): boolean {
  const letters = countMatches(sample, /\p{L}/gu);
  if (letters < 20) return false;
  const latin = countMatches(sample, /\p{Script=Latin}/gu);
  return latin / letters < 0.5;
}

function countMatches(text: string, re: RegExp): number {
  if (!re.global) return re.test(text) ? 1 : 0;
  let count = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) count++;
  re.lastIndex = 0;
  return count;
}
