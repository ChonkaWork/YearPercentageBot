import { normalizeTree } from './normalize';
import { listItems } from './plainText';
import {
  containsBlock,
  el,
  headingLevel,
  isBlockLike,
  isElement,
  isGenericBlockTag,
  isStructuralBlockTag,
  textContent,
  type SnapElement,
  type SnapNode,
} from './snapshot';
import { buildTableModel, combineHeaderRows, extractTableData, type TableData } from './table';

/**
 * CommonMark / GitHub-flavored Markdown from a snapshot: ATX headings, emphasis, inline
 * code, fenced code blocks with the language, links and images with absolute URLs,
 * nested lists, task lists, blockquotes, pipe tables and hard line breaks. Page text is
 * escaped so it can't turn into Markdown syntax by accident, without the noise of
 * escaping every underscore in snake_case.
 */

export interface MarkdownOptions {
  bullet?: '-' | '*' | '+';
  emphasis?: '*' | '_';
}

interface Ctx {
  bullet: string;
  emphasis: string;
  inLink: boolean;
  inStrong: boolean;
  inEmphasis: boolean;
  inStrike: boolean;
}

const HARD_BREAK = '  \n';

export function toMarkdown(nodes: readonly SnapNode[], options: MarkdownOptions = {}): string {
  return blocks(normalizeTree(nodes), makeCtx(options)).join('\n\n').replace(/^\n+|\s+$/g, '');
}

/** A whole table as a Markdown table (from a normalized tree). */
export function tableToMarkdown(table: SnapElement, options: MarkdownOptions = {}): string {
  return tableMarkdown(table, makeCtx(options));
}

function makeCtx(options: MarkdownOptions): Ctx {
  return {
    bullet: options.bullet ?? '-',
    emphasis: options.emphasis ?? '*',
    inLink: false,
    inStrong: false,
    inEmphasis: false,
    inStrike: false,
  };
}

// --- Blocks -----------------------------------------------------------------------------

function blocks(nodes: readonly SnapNode[], ctx: Ctx): string[] {
  const out: string[] = [];
  let run: SnapNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const value = paragraph(run, ctx);
    run = [];
    if (value) out.push(value);
  };
  for (const node of nodes) {
    if (isElement(node) && isBlockLike(node)) {
      flush();
      out.push(...block(node, ctx));
    } else if (isElement(node) && containsBlock(node)) {
      flush();
      out.push(...blocks(node.c, ctx));
    } else {
      run.push(node);
    }
  }
  flush();
  return out.filter((value) => value.trim() !== '');
}

function block(node: SnapElement, ctx: Ctx): string[] {
  const level = headingLevel(node.tag);
  if (level > 0) {
    const value = oneLine(inline(node.c, ctx));
    return value ? [`${'#'.repeat(level)} ${value.replace(/(\s)(#+)$/, '$1\\$2')}`] : [];
  }
  switch (node.tag) {
    case 'pre':
      return [codeBlock(node)];
    case 'ul':
    case 'ol':
      return [list(node, ctx)];
    case 'li':
      return [list(el('ul', null, node), ctx)];
    case 'blockquote': {
      const inner = blocks(node.c, ctx).join('\n\n');
      return inner ? [inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')] : [];
    }
    case 'table': {
      const caption = node.c.find((child): child is SnapElement => isElement(child) && child.tag === 'caption');
      const title = caption ? oneLine(inline(caption.c, ctx)) : '';
      return [title, tableMarkdown(node, ctx)].filter(Boolean);
    }
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
      return [tableMarkdown(el('table', null, node), ctx)];
    case 'hr':
      return ['---'];
    case 'dt': {
      const value = oneLine(inline(node.c, ctx));
      return value ? [ctx.inStrong ? value : wrap(value, '**')] : [];
    }
    default:
      // An inline element the page displays as a block (e.g. a card link): its own paragraph.
      if (!isStructuralBlockTag(node.tag) && !isGenericBlockTag(node.tag) && !containsBlock(node)) {
        const value = paragraph([node], ctx);
        return value ? [value] : [];
      }
      return blocks(node.c, ctx);
  }
}

function paragraph(run: readonly SnapNode[], ctx: Ctx): string {
  const value = inline(run, ctx).trim();
  return value ? value.split('\n').map(escapeLineStart).join('\n') : '';
}

/** Escapes text at the start of a line that Markdown would read as a block marker. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)([-+*])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
    .replace(/^(\s*)([-=])(?=[-=]*\s*$)/, '$1\\$2');
}

function codeBlock(node: SnapElement): string {
  const code = textContent(node).replace(/^\n/, '').replace(/\n+$/, '');
  const lang = node.a?.lang ?? findCodeLanguage(node) ?? '';
  const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

function findCodeLanguage(node: SnapElement): string | undefined {
  for (const child of node.c) {
    if (!isElement(child)) continue;
    if (child.a?.lang) return child.a.lang;
    const nested = findCodeLanguage(child);
    if (nested) return nested;
  }
  return undefined;
}

// --- Lists ------------------------------------------------------------------------------

const LIST_BLOCK = /^(?:[-*+]|\d{1,9}[.)])(?: |$)/;

function list(node: SnapElement, ctx: Ctx): string {
  const ordered = node.tag === 'ol';
  const step = node.a?.reversed ? -1 : 1;
  let number = node.a?.start ?? 1;
  const items: string[] = [];
  for (const item of listItems(node)) {
    if (item.a?.value !== undefined) number = item.a.value;
    const marker = ordered ? `${number}.` : ctx.bullet;
    number += step;
    const parts = blocks(item.c, ctx);
    if (parts.length === 0) continue;
    // A nested list right after the item's text stays tight; other blocks get a blank line.
    let body = parts[0] ?? '';
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i] ?? '';
      body += (LIST_BLOCK.test(part) ? '\n' : '\n\n') + part;
    }
    const indent = ' '.repeat(marker.length + 1);
    items.push(
      body
        .split('\n')
        .map((line, index) => (index === 0 ? `${marker} ${line}` : line ? indent + line : ''))
        .join('\n'),
    );
  }
  return items.join('\n');
}

// --- Tables -----------------------------------------------------------------------------

const MAX_PAD = 40;

function tableMarkdown(table: SnapElement, ctx: Ctx): string {
  const data = extractTableData(buildTableModel(table), (cell) => tableCell(cell, ctx), 'repeat');
  return formatMarkdownTable(data);
}

function tableCell(cell: SnapElement, ctx: Ctx): string {
  return blocks(cell.c, ctx)
    .join('\n')
    .replace(/ *\n */g, '<br>')
    .replace(/\|/g, '\\|');
}

/** A GitHub pipe table. Tables without header rows get an empty header row. */
export function formatMarkdownTable(data: TableData): string {
  if (data.width === 0 || data.rows.length === 0) return '';
  const header = data.headerRows > 0 ? combineHeaderRows(data) : new Array<string>(data.width).fill('');
  const body = data.rows.slice(data.headerRows);
  const widths = header.map((label, column) => {
    const longest = Math.max(displayWidth(label), ...body.map((row) => displayWidth(row[column] ?? '')));
    return Math.min(MAX_PAD, Math.max(3, longest));
  });
  const line = (cells: readonly string[]) =>
    `| ${cells.map((value, column) => value + ' '.repeat(Math.max(0, (widths[column] ?? 3) - displayWidth(value)))).join(' | ')} |`;
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join('\n');
}

function displayWidth(value: string): number {
  return [...value].length;
}

// --- Inline -----------------------------------------------------------------------------

function inline(nodes: readonly SnapNode[], ctx: Ctx): string {
  let out = '';
  for (const node of nodes) out += isElement(node) ? inlineElement(node, ctx) : escapeText(node.v);
  return out;
}

function inlineElement(node: SnapElement, ctx: Ctx): string {
  switch (node.tag) {
    case 'br':
      return HARD_BREAK;
    case 'strong':
    case 'b':
      return ctx.inStrong ? inline(node.c, ctx) : wrap(inline(node.c, { ...ctx, inStrong: true }), '**');
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
    case 'var':
      return ctx.inEmphasis ? inline(node.c, ctx) : wrap(inline(node.c, { ...ctx, inEmphasis: true }), ctx.emphasis);
    case 'del':
    case 's':
    case 'strike':
      return ctx.inStrike ? inline(node.c, ctx) : wrap(inline(node.c, { ...ctx, inStrike: true }), '~~');
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      return codeSpan(textContent(node));
    case 'a':
      return link(node, ctx);
    case 'img':
      return image(node);
    case 'input':
      return node.a?.checked ? '[x] ' : '[ ] ';
    case 'q':
      return `“${inline(node.c, ctx)}”`;
    case 'pre':
      return codeSpan(textContent(node));
    default:
      return inline(node.c, ctx);
  }
}

/** Wraps in a delimiter, moving surrounding spaces outside (`** bold**` doesn't render). */
function wrap(inner: string, delimiter: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const [, lead = '', core = '', trail = ''] = match ?? [];
  if (!core) return inner;
  return `${lead}${delimiter}${core}${delimiter}${trail}`;
}

function codeSpan(content: string): string {
  const value = content.replace(/\s*\n\s*/g, ' ');
  if (!value.trim()) return value ? ' ' : '';
  const fence = '`'.repeat(longestRun(value, '`') + 1);
  const pad = /^`|`$/.test(value) || (/^ .* $/.test(value) && value.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

function link(node: SnapElement, ctx: Ctx): string {
  const content = inline(node.c, { ...ctx, inLink: true }).split(HARD_BREAK).join(' ');
  const href = node.a?.href;
  if (!href || ctx.inLink) return content;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const [, lead = '', core = '', trail = ''] = match ?? [];
  if (!core) return content;
  const plain = unescape(core);
  if (/^https?:\/\//i.test(href) && plain === href && !/[\s<>]/.test(href)) return `${lead}<${href}>${trail}`;
  if (/^mailto:/i.test(href) && plain === href.slice(7) && /^[^\s<>@]+@[^\s<>@]+$/.test(plain)) return `${lead}<${plain}>${trail}`;
  return `${lead}[${core}](${destination(href)})${trail}`;
}

function image(node: SnapElement): string {
  const alt = (node.a?.alt ?? '').replace(/\s+/g, ' ').trim();
  const src = node.a?.src;
  // data: images would paste kilobytes of base64 into the Markdown; keep the description.
  if (!src || src.startsWith('data:')) return alt ? escapeText(alt) : '';
  return `![${alt.replace(/[\\[\]]/g, '\\$&')}](${destination(src)})`;
}

/** A link destination that survives Markdown parsing: no spaces, no unbalanced parentheses. */
function destination(href: string): string {
  let value = href.replace(/ /g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E');
  let depth = 0;
  let balanced = true;
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) balanced = false;
  }
  if (!balanced || depth !== 0) value = value.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return value;
}

// --- Escaping ---------------------------------------------------------------------------

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Escapes page text so it stays text. Context-aware to avoid noise: `2 * 3` and
 * `snake_case` stay as they are, `*note*` and `_init_` don't turn into emphasis.
 */
export function escapeText(value: string): string {
  let out = '';
  const tildes = (value.match(/~/g)?.length ?? 0) >= 2;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] ?? '';
    const previous = value[i - 1] ?? '';
    const next = value[i + 1] ?? '';
    switch (ch) {
      case '\\':
        out += ASCII_PUNCTUATION.test(next) ? '\\\\' : '\\';
        break;
      case '`':
      case '[':
      case ']':
        out += `\\${ch}`;
        break;
      case '*':
        out += isSpace(previous) && isSpace(next) ? '*' : '\\*';
        break;
      case '_':
        out += isWordChar(previous) && isWordChar(next) ? '_' : '\\_';
        break;
      case '<':
        out += /[A-Za-z/!?]/.test(next) ? '\\<' : '<';
        break;
      case '~':
        out += tildes ? '\\~' : '~';
        break;
      case '&':
        out += /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(value.slice(i, i + 12)) ? '\\&' : '&';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function unescape(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function isSpace(ch: string): boolean {
  return ch === '' || /\s/.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function oneLine(value: string): string {
  return value.split(HARD_BREAK).join(' ').replace(/\s*\n\s*/g, ' ').trim();
}

function longestRun(value: string, ch: string): number {
  let longest = 0;
  let current = 0;
  for (const c of value) {
    current = c === ch ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
