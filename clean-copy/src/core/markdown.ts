import { applyEditsToText, type Edit, type StepResult } from './changes';
import { forEachLine } from './steps';
import { bareUrl } from './text';

/**
 * "Remove Markdown syntax" (optional): text written in Markdown (AI answers, READMEs, chat
 * messages) pasted as plain text.
 *
 *   # Heading           → Heading
 *   **bold**, *italic*  → bold, italic        (also __, _ and ~~strike~~)
 *   `code`              → code
 *   [text](url)         → text (url)          ![alt](url) → alt, <https://…> → https://…
 *   * item, + item      → - item              (Keep bullets decides whether "- " stays)
 *   ---, ***, ===       → (removed)
 *
 * Fenced code blocks (``` or ~~~) are kept verbatim, fences included. Quotes (>), tables
 * and numbered lists are left as they are. Pure: no DOM, no Chrome APIs.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}=+[ \t]*$/;
const LIST_MARKER = /^([ \t]*)[*+][ \t]+(?=\S)/;

const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!~|<>])/g;
const LINK =
  /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/dg;
const AUTOLINK = /<(https?:\/\/[^<>\s]+)>/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>]+/g;
const EMPHASIS: readonly { pattern: RegExp; size: number }[] = [
  { pattern: /\*\*(?!\s)(.+?)(?<!\s)\*\*/g, size: 2 },
  { pattern: /(?<![\p{L}\p{N}_])__(?!\s)(.+?)(?<!\s)__(?![\p{L}\p{N}_])/gu, size: 2 },
  { pattern: /~~(?!\s)(.+?)(?<!\s)~~/g, size: 2 },
  { pattern: /\*(?!\s)(.+?)(?<!\s)\*/g, size: 1 },
  { pattern: /(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, size: 1 },
];

export function markdownStep(text: string): StepResult & { count: number } {
  const edits: Edit[] = [];
  let count = 0;
  let fence: { char: string; size: number } | null = null;
  let previousBlank = true;

  forEachLine(text, (start, end) => {
    const line = text.slice(start, end);
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.size) fence = null;
      previousBlank = false;
      return;
    }
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      fence = { char: open[0] ?? '`', size: open.length };
      previousBlank = false;
      return;
    }
    if (THEMATIC_BREAK.test(line) || (!previousBlank && SETEXT_UNDERLINE.test(line))) {
      edits.push({ start, end, kind: 'markdown' });
      count++;
      previousBlank = true;
      return;
    }
    let from = start;
    let to = end;
    const heading = HEADING.exec(line);
    if (heading) {
      edits.push({ start: start + (heading[1]?.length ?? 0), end: start + heading[0].length, kind: 'markdown' });
      count++;
      from = start + heading[0].length;
      const close = HEADING_CLOSE.exec(text.slice(from, end));
      if (close) {
        to = from + close.index;
        edits.push({ start: to, end, kind: 'markdown' });
      }
    } else {
      const marker = LIST_MARKER.exec(line);
      if (marker) {
        const at = start + (marker[1]?.length ?? 0);
        edits.push({ start: at, end: at + 1, insert: '-', kind: 'markdown' });
        count++;
        from = start + marker[0].length;
      }
    }
    count += inlineEdits(text, from, to, edits);
    previousBlank = !line.trim();
  });

  return { text: applyEditsToText(text, edits), edits, count };
}

/**
 * Inline syntax in `text[from, to)`. Works on a masked copy of the line: characters that are
 * protected (code, addresses) or already removed become a neutral letter, so later patterns
 * neither match inside them nor break on them. Returns the number of constructs removed.
 */
function inlineEdits(text: string, from: number, to: number, edits: Edit[]): number {
  const line = text.slice(from, to);
  if (!/[`\\[<*_~]/.test(line)) return 0;
  const mask = line.split('');
  let count = 0;
  const masked = () => mask.join('');
  const protect = (start: number, end: number) => mask.fill('x', start, end);
  const remove = (start: number, end: number, insert?: string) => {
    if (end <= start && !insert) return;
    edits.push(insert ? { start: from + start, end: from + end, insert, kind: 'markdown' } : { start: from + start, end: from + end, kind: 'markdown' });
    protect(start, end);
  };

  for (const match of masked().matchAll(CODE_SPAN)) {
    const size = match[1]?.length ?? 1;
    const start = match.index;
    const end = start + match[0].length;
    remove(start, start + size);
    protect(start + size, end - size);
    remove(end - size, end);
    count++;
  }

  for (const match of masked().matchAll(ESCAPE)) {
    remove(match.index, match.index + 1);
    protect(match.index + 1, match.index + 2);
  }

  for (const match of masked().matchAll(LINK)) {
    const indices = (match as RegExpMatchArray & { indices?: [number, number][] }).indices;
    const whole = indices?.[0];
    const label = indices?.[2];
    const target = indices?.[3];
    if (!whole || !label || !target) continue;
    const [start, end] = whole;
    let [urlStart, urlEnd] = target;
    if (line[urlStart] === '<') {
      urlStart++;
      urlEnd--;
    }
    const url = line.slice(urlStart, urlEnd);
    const labelText = line.slice(label[0], label[1]).trim();
    count++;
    if (match[1] === '!' || !url || labelText === url || bareUrl(labelText) === bareUrl(url)) {
      // Images keep their alt text; a link whose text is its address keeps just the address.
      remove(start, label[0]);
      remove(label[1], end);
      continue;
    }
    remove(start, start + 1);
    remove(label[1], urlStart, ' (');
    protect(urlStart, urlEnd);
    remove(urlEnd, end - 1);
    protect(end - 1, end);
  }

  for (const match of masked().matchAll(AUTOLINK)) {
    const end = match.index + match[0].length;
    remove(match.index, match.index + 1);
    protect(match.index + 1, end - 1);
    remove(end - 1, end);
    count++;
  }

  for (const match of masked().matchAll(BARE_URL)) protect(match.index, match.index + match[0].length);

  for (const { pattern, size } of EMPHASIS) {
    for (const match of masked().matchAll(pattern)) {
      const end = match.index + match[0].length;
      remove(match.index, match.index + size);
      remove(end - size, end);
      count++;
    }
  }
  return count;
}
