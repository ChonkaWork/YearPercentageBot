/**
 * Small, safe Markdown → HTML renderer for the print view.
 *
 * Supports what the exporter produces (CommonMark basics, GFM tables, strikethrough and task
 * lists, `$…$` / `$$…$$` math as TeX source) and renders anything else as text. It is safe by
 * construction: raw HTML is never passed through (every character of content is escaped), and
 * links only get http(s)/mailto targets. Images are rendered as links, so opening the print view
 * never loads anything from the network.
 */

type Align = '' | 'left' | 'center' | 'right';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'math'; text: string }
  | { type: 'rule' }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { type: 'table'; align: Align[]; header: string[]; rows: string[][] };

interface ListItem {
  task: boolean | null;
  children: Block[];
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd').split('\n').map(expandTabs);
  return renderBlocks(parseBlocks(lines), false);
}

// --- Block parsing ------------------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:( {1,4})(.*)|[ \t]*)$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function expandTabs(line: string): string {
  const match = /^[ \t]+/.exec(line);
  if (!match || !match[0].includes('\t')) return line;
  let width = 0;
  for (const char of match[0]) width = char === '\t' ? width + 4 - (width % 4) : width + 1;
  return ' '.repeat(width) + line.slice(match[0].length);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

interface Marker {
  ordered: boolean;
  start: number;
  /** Bullet character or ordered delimiter; items of one list share it. */
  kind: string;
  /** Column where the item's content starts. */
  contentIndent: number;
  content: string;
}

function listMarker(line: string): Marker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indent = '', marker = '', spaces, content = ''] = match;
  // "---" or "* * *" is a rule, not a list.
  if (RULE.test(line)) return null;
  const ordered = /\d/.test(marker);
  return {
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    kind: ordered ? marker.slice(-1) : marker,
    contentIndent: indent.length + marker.length + (spaces ? spaces.length : 1),
    content: spaces ? content : '',
  };
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || listMarker(line) !== null || /^ {0,3}\$\$/.test(line);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent = '', marker = '', language = ''] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(current);
        i++;
        if (close?.[1] && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        body.push(current.slice(Math.min(indent.length, indentOf(current))));
      }
      blocks.push({ type: 'code', language, text: body.join('\n') });
      continue;
    }

    if (/^ {0,3}\$\$/.test(line)) {
      const single = /^ {0,3}\$\$(.+)\$\$[ \t]*$/.exec(line);
      if (single) {
        blocks.push({ type: 'math', text: single[1]?.trim() ?? '' });
        i++;
        continue;
      }
      const body: string[] = [line.replace(/^ {0,3}\$\$/, '')];
      i++;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        i++;
        const end = current.lastIndexOf('$$');
        if (end !== -1) {
          body.push(current.slice(0, end));
          break;
        }
        body.push(current);
      }
      blocks.push({ type: 'math', text: body.join('\n').trim() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const quoted = QUOTE.exec(current);
        if (quoted) inner.push(quoted[1] ?? '');
        else if (!isBlank(current) && !startsBlock(current) && inner.length > 0 && !isBlank(inner[inner.length - 1] ?? '')) inner.push(current);
        else break;
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      i = parseList(lines, i, marker, blocks);
      continue;
    }

    if (line.includes('|') && DELIMITER_ROW.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1] ?? '').map(alignOf);
      if (header.length === align.length) {
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && !isBlank(lines[i] ?? '') && (lines[i] ?? '').includes('|')) {
          const cells = splitRow(lines[i] ?? '');
          rows.push(Array.from({ length: header.length }, (_, index) => cells[index] ?? ''));
          i++;
        }
        blocks.push({ type: 'table', align, header, rows });
        continue;
      }
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i] ?? '') && !startsBlock(lines[i] ?? '')) {
      paragraph.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ type: 'paragraph', text: paragraph.map((current) => current.replace(/^ +/, '')).join('\n') });
  }
  return blocks;
}

function parseList(lines: string[], start: number, first: Marker, blocks: Block[]): number {
  const items: ListItem[] = [];
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const marker = listMarker(lines[i] ?? '');
    if (!marker || marker.ordered !== first.ordered || marker.kind !== first.kind) break;
    const body: string[] = [marker.content];
    i++;
    let previousBlank = false;
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (isBlank(current)) {
        body.push('');
        previousBlank = true;
        i++;
        continue;
      }
      if (indentOf(current) >= marker.contentIndent) {
        body.push(current.slice(marker.contentIndent));
        previousBlank = false;
        i++;
        continue;
      }
      // Lazy continuation of a paragraph.
      if (!previousBlank && !startsBlock(current)) {
        body.push(current.trim());
        i++;
        continue;
      }
      break;
    }
    let trailingBlank = false;
    while (body.length > 1 && isBlank(body[body.length - 1] ?? '')) {
      body.pop();
      trailingBlank = true;
    }
    if (trailingBlank && i < lines.length && listMarker(lines[i] ?? '')?.kind === first.kind) loose = true;
    const children = parseBlocks(body);
    if (children.filter((child) => child.type !== 'list').length > 1) loose = true;
    let task: boolean | null = null;
    const head = children[0];
    if (head?.type === 'paragraph') {
      const box = /^\[([ xX])\][ \t]+/.exec(head.text);
      if (box) {
        task = box[1] !== ' ';
        head.text = head.text.slice(box[0].length);
      }
    }
    items.push({ task, children });
  }
  blocks.push({ type: 'list', ordered: first.ordered, start: first.start, loose, items });
  return i;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      cell += '|';
      index++;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

// --- Block rendering ----------------------------------------------------------------------------

function renderBlocks(blocks: Block[], tight: boolean): string {
  return blocks.map((block) => renderBlock(block, tight)).join('\n');
}

function renderBlock(block: Block, tight: boolean): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
    case 'paragraph':
      return tight ? renderInline(block.text) : `<p>${renderInline(block.text)}</p>`;
    case 'code': {
      const language = block.language.replace(/[^\w#+.-]/g, '');
      const label = language ? `<div class="code-language">${escapeHtml(language)}</div>` : '';
      const className = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<div class="code-block">${label}<pre><code${className}>${escapeHtml(block.text)}</code></pre></div>`;
    }
    case 'math':
      return `<div class="math-display">${escapeHtml(block.text)}</div>`;
    case 'rule':
      return '<hr>';
    case 'quote':
      return `<blockquote>${renderBlocks(block.children, false)}</blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      const items = block.items.map((item) => {
        const box = item.task === null ? '' : `<input type="checkbox" disabled${item.task ? ' checked' : ''}> `;
        const className = item.task === null ? '' : ' class="task"';
        return `<li${className}>${box}${renderBlocks(item.children, !block.loose)}</li>`;
      });
      return `<${tag}${start}>${items.join('')}</${tag}>`;
    }
    case 'table': {
      const cell = (tag: string, text: string, index: number) => {
        const align = block.align[index];
        return `<${tag}${align ? ` style="text-align: ${align}"` : ''}>${renderInline(text)}</${tag}>`;
      };
      const head = `<thead><tr>${block.header.map((text, index) => cell('th', text, index)).join('')}</tr></thead>`;
      const body = block.rows.map((row) => `<tr>${row.map((text, index) => cell('td', text, index)).join('')}</tr>`).join('');
      return `<table>${head}<tbody>${body}</tbody></table>`;
    }
  }
}

// --- Inline -------------------------------------------------------------------------------------

type Inline =
  | { type: 'html'; html: string }
  | { type: 'delim'; char: string; length: number; canOpen: boolean; canClose: boolean };

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp);/;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function renderInline(source: string): string {
  const nodes: Inline[] = [];
  let text = '';
  const pushText = () => {
    if (text) nodes.push({ type: 'html', html: escapeHtml(text) });
    text = '';
  };
  const pushHtml = (html: string) => {
    pushText();
    nodes.push({ type: 'html', html });
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (char === '\\') {
      if (next === '\n') {
        pushHtml('<br>\n');
        i += 2;
      } else if (ASCII_PUNCTUATION.test(next)) {
        text += next;
        i += 2;
      } else {
        text += char;
        i++;
      }
      continue;
    }

    if (char === '\n') {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, '');
      pushHtml(hard ? '<br>\n' : '\n');
      i++;
      continue;
    }

    if (char === '`') {
      const run = /^`+/.exec(source.slice(i))?.[0] ?? '`';
      const close = findCodeClose(source, i + run.length, run.length);
      if (close !== -1) {
        let code = source.slice(i + run.length, close).replace(/\n/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        pushHtml(`<code>${escapeHtml(code)}</code>`);
        i = close + run.length;
      } else {
        text += run;
        i += run.length;
      }
      continue;
    }

    if (char === '$') {
      const math = parseInlineMath(source, i);
      if (math) {
        pushHtml(`<span class="math-inline">${escapeHtml(math.tex)}</span>`);
        i = math.end;
      } else {
        text += char;
        i++;
      }
      continue;
    }

    if (char === '[' || (char === '!' && next === '[')) {
      const image = char === '!';
      const link = parseLink(source, image ? i + 1 : i);
      if (link) {
        const href = safeHref(link.destination);
        if (image) {
          const alt = plainText(link.label);
          const label = alt ? `Image: ${alt}` : 'Image';
          pushHtml(href ? `<a class="image-link" href="${escapeAttribute(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(`[${label}]`));
        } else {
          const label = renderInline(link.label);
          pushHtml(href ? `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${label}</a>` : label);
        }
        i = link.end;
        continue;
      }
      text += char;
      i++;
      continue;
    }

    if (char === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i.exec(source.slice(i));
      const href = auto?.[1] ? safeHref(auto[1]) : null;
      if (auto && href) {
        pushHtml(`<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${escapeHtml(auto[1] ?? '')}</a>`);
        i += auto[0].length;
        continue;
      }
      text += char;
      i++;
      continue;
    }

    if (char === '&') {
      const entity = ENTITY.exec(source.slice(i));
      if (entity?.[1]) {
        text += decodeEntity(entity[1]);
        i += entity[0].length;
        continue;
      }
      text += char;
      i++;
      continue;
    }

    if (char === '*' || char === '_' || char === '~') {
      const run = new RegExp(`^\\${char}+`).exec(source.slice(i))?.[0] ?? char;
      const before = i === 0 ? ' ' : (source[i - 1] ?? ' ');
      const after = source[i + run.length] ?? ' ';
      const leftFlanking = !/\s/.test(after) && (!isPunctuation(after) || /\s/.test(before) || isPunctuation(before));
      const rightFlanking = !/\s/.test(before) && (!isPunctuation(before) || /\s/.test(after) || isPunctuation(after));
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (char === '_') {
        canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
        canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
      }
      if (char === '~' && run.length !== 2) {
        text += run;
      } else {
        pushText();
        nodes.push({ type: 'delim', char, length: run.length, canOpen, canClose });
      }
      i += run.length;
      continue;
    }

    text += char;
    i++;
  }
  pushText();
  return resolveEmphasis(nodes);
}

/** CommonMark's delimiter matching, simplified (no rule of three). */
function resolveEmphasis(nodes: Inline[]): string {
  const items: Inline[] = [...nodes];
  for (let closerIndex = 0; closerIndex < items.length; closerIndex++) {
    const closer = items[closerIndex];
    if (closer?.type !== 'delim' || !closer.canClose) continue;
    for (let openerIndex = closerIndex - 1; openerIndex >= 0; openerIndex--) {
      const opener = items[openerIndex];
      if (opener?.type !== 'delim' || !opener.canOpen || opener.char !== closer.char) continue;
      const use = closer.char === '~' ? 2 : closer.length >= 2 && opener.length >= 2 ? 2 : 1;
      if (opener.length < use || closer.length < use) continue;
      const tag = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const inner = items
        .slice(openerIndex + 1, closerIndex)
        .map(delimiterText)
        .join('');
      opener.length -= use;
      closer.length -= use;
      const replacement: Inline[] = [];
      if (opener.length > 0) replacement.push(opener);
      replacement.push({ type: 'html', html: `<${tag}>${inner}</${tag}>` });
      if (closer.length > 0) replacement.push(closer);
      items.splice(openerIndex, closerIndex - openerIndex + 1, ...replacement);
      closerIndex = openerIndex + replacement.length - (closer.length > 0 ? 2 : 1);
      break;
    }
  }
  return items.map(delimiterText).join('');
}

function delimiterText(node: Inline): string {
  return node.type === 'html' ? node.html : escapeHtml(node.char.repeat(node.length));
}

function findCodeClose(source: string, from: number, length: number): number {
  const pattern = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, 'g');
  pattern.lastIndex = from;
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

function parseInlineMath(source: string, start: number): { tex: string; end: number } | null {
  if (source[start + 1] === '$') {
    const close = source.indexOf('$$', start + 2);
    if (close === -1 || close === start + 2) return null;
    return { tex: source.slice(start + 2, close).trim(), end: close + 2 };
  }
  const after = source[start + 1] ?? '';
  if (!after || /\s/.test(after)) return null;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '\n' && source[index + 1] === '\n') return null;
    if (char === '$') {
      if (/\s/.test(source[index - 1] ?? ' ')) return null;
      return { tex: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function parseLink(source: string, start: number): { label: string; destination: string; end: number } | null {
  let depth = 0;
  let index = start;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '`') {
      const run = /^`+/.exec(source.slice(index))?.[0].length ?? 1;
      const close = findCodeClose(source, index + run, run);
      if (close !== -1) index = close + run - 1;
      continue;
    }
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || source[index + 1] !== '(') return null;
  const label = source.slice(start + 1, index);
  let cursor = index + 2;
  while (source[cursor] === ' ') cursor++;
  let destination = '';
  if (source[cursor] === '<') {
    const close = source.indexOf('>', cursor);
    if (close === -1) return null;
    destination = source.slice(cursor + 1, close);
    cursor = close + 1;
  } else {
    let parens = 0;
    const from = cursor;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor] ?? '';
      if (char === '\\') {
        cursor++;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === '(') parens++;
      if (char === ')') {
        if (parens === 0) break;
        parens--;
      }
    }
    destination = source.slice(from, cursor);
  }
  while (source[cursor] === ' ') cursor++;
  const title = /^(?:"[^"]*"|'[^']*')/.exec(source.slice(cursor));
  if (title) cursor += title[0].length;
  while (source[cursor] === ' ') cursor++;
  if (source[cursor] !== ')') return null;
  return { label, destination: destination.replace(/\\([!-/:-@[-`{-~])/g, '$1'), end: cursor + 1 };
}

function plainText(markdown: string): string {
  return markdown.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/[*_`]/g, '');
}

function isPunctuation(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char);
}

function decodeEntity(name: string): string {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  }
  return NAMED_ENTITIES[name] ?? `&${name};`;
}

// --- Escaping -----------------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(text: string): string {
  return escapeHtml(text);
}

/** Absolute http(s) and mailto URLs only. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}
