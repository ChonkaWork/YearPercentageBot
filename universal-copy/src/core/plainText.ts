import { formatMath } from './mathml';
import { normalizeTree } from './normalize';
import {
  containsBlock,
  el,
  isBlockLike,
  isElement,
  isGenericBlockTag,
  isStructuralBlockTag,
  textContent,
  type SnapElement,
  type SnapNode,
} from './snapshot';
import { buildTableModel, extractTableData } from './table';
import { bareUrl, isSamePageLink, tidyText } from './text';

/**
 * "Clean text": what you see, without the page's formatting. Paragraphs and headings
 * are separated by a blank line, lists become "- item" / "1. item" (nested lists
 * indented), table rows become tab-separated lines, code keeps its layout. Links keep
 * their text, optionally followed by the URL.
 */

export interface PlainTextOptions {
  /** Add "(https://...)" after link text. */
  includeLinkUrls?: boolean;
  /** The page URL, so links to the same page (tables of contents, anchors) don't get one. */
  pageUrl?: string;
  /** Between paragraphs: a blank line (default) or a single line break. */
  paragraphs?: 'blank' | 'single';
  /** Marker for unordered list items. */
  bullet?: string;
}

interface Ctx {
  options: PlainTextOptions;
  /** Inside a list item or table cell: blocks are separated by a single line break. */
  compact: boolean;
}

interface Block {
  text: string;
  /** Line breaks wanted before/after: 1 = new line, 2 = blank line. */
  before: number;
  after: number;
}

export function toPlainText(nodes: readonly SnapNode[], options: PlainTextOptions = {}): string {
  return tidyText(joinBlocks(blocks(normalizeTree(nodes), { options, compact: false })));
}

/**
 * Text of one table cell (from a normalized tree): its blocks on separate lines, no blank
 * lines. A cell with only images (icons, check marks) falls back to their alt text.
 */
export function plainCellText(cell: SnapElement, options: PlainTextOptions = {}): string {
  const value = joinBlocks(blocks(cell.c, { options, compact: true }))
    .replace(/\t/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ +$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
  return value || imageAlts(cell);
}

function blocks(nodes: readonly SnapNode[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  let run: SnapNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const value = inline(run, ctx);
    run = [];
    if (value.trim()) out.push({ text: value.replace(/^\n+|\n+$/g, ''), before: 1, after: 1 });
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
  return out;
}

function block(node: SnapElement, ctx: Ctx): Block[] {
  const gap = ctx.compact || ctx.options.paragraphs === 'single' ? 1 : 2;
  switch (node.tag) {
    case 'pre':
      return [{ text: codeText(node), before: gap, after: gap }];
    case 'math':
      return [{ text: formatMath(node.a?.tex ?? '', true), before: gap, after: gap }];
    case 'ul':
    case 'ol':
      return [{ text: listText(node, ctx), before: gap, after: gap }];
    case 'li':
      return [{ text: listItemText(node, ctx.options.bullet ?? '-', ctx), before: 1, after: 1 }];
    case 'table': {
      const caption = node.c.find((child): child is SnapElement => isElement(child) && child.tag === 'caption');
      const title = caption ? inline(caption.c, ctx).replace(/\s*\n\s*/g, ' ').trim() : '';
      const table: Block = { text: tableText(node, ctx), before: title ? 1 : gap, after: gap };
      return title ? [{ text: title, before: gap, after: 1 }, table] : [table];
    }
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
      return block(el('table', null, node), ctx);
    case 'hr':
      return [{ text: '', before: gap, after: gap }];
    case 'p':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'blockquote':
    case 'figure':
    case 'dl':
    case 'details':
      return surround(blocks(node.c, ctx), gap);
    default:
      // An inline element the page displays as a block (e.g. a card link): one line, link intact.
      if (!isStructuralBlockTag(node.tag) && !isGenericBlockTag(node.tag) && !containsBlock(node)) {
        const value = inline([node], ctx);
        return value.trim() ? [{ text: value, before: 1, after: 1 }] : [];
      }
      return blocks(node.c, ctx);
  }
}

function surround(list: Block[], gap: number): Block[] {
  const first = list[0];
  const last = list[list.length - 1];
  if (first) first.before = Math.max(first.before, gap);
  if (last) last.after = Math.max(last.after, gap);
  return list;
}

function joinBlocks(list: readonly Block[]): string {
  let out = '';
  let previousAfter = 0;
  let pending = 0;
  for (const item of list) {
    if (!item.text.trim()) {
      pending = Math.max(pending, item.before, item.after);
      continue;
    }
    if (out) out += Math.max(previousAfter, item.before, pending) >= 2 ? '\n\n' : '\n';
    out += item.text;
    previousAfter = item.after;
    pending = 0;
  }
  return out;
}

function inline(nodes: readonly SnapNode[], ctx: Ctx): string {
  let out = '';
  for (const node of nodes) {
    if (!isElement(node)) {
      out += node.v;
      continue;
    }
    switch (node.tag) {
      case 'br':
        out += '\n';
        break;
      case 'img':
        out += emojiAlt(node);
        break;
      case 'input':
        out += node.a?.checked ? '[x] ' : '[ ] ';
        break;
      case 'a':
        out += linkText(node, ctx);
        break;
      case 'q':
        out += `“${inline(node.c, ctx)}”`;
        break;
      case 'math':
        out += formatMath(node.a?.tex ?? '', false);
        break;
      default:
        out += inline(node.c, ctx);
    }
  }
  return out;
}

function linkText(node: SnapElement, ctx: Ctx): string {
  const content = inline(node.c, ctx);
  const href = node.a?.href;
  const label = content.trim();
  if (!ctx.options.includeLinkUrls || !href || !label) return content;
  if (isSamePageLink(href, ctx.options.pageUrl)) return content;
  const bare = bareUrl(href);
  if (label === href || bareUrl(label) === bare || label.includes(bare)) return content;
  const shown = /^(?:mailto|tel):/i.test(href) ? href.replace(/^(?:mailto|tel):/i, '') : href;
  const trailing = /\s*$/.exec(content)?.[0] ?? '';
  return `${content.slice(0, content.length - trailing.length)} (${shown})${trailing}`;
}

/** Emoji drawn as images (Twitter, Slack, Discord...) keep their emoji; other images are dropped. */
function emojiAlt(node: SnapElement): string {
  const alt = node.a?.alt?.trim() ?? '';
  return alt && alt.length <= 8 && /\p{Extended_Pictographic}/u.test(alt) ? alt : '';
}

function imageAlts(node: SnapElement): string {
  const alts: string[] = [];
  const walk = (current: SnapNode) => {
    if (!isElement(current)) return;
    if (current.tag === 'img' && current.a?.alt?.trim()) alts.push(current.a.alt.trim());
    current.c.forEach(walk);
  };
  walk(node);
  return alts.join(' ');
}

function codeText(node: SnapElement): string {
  return textContent(node).replace(/^\n/, '').replace(/\s+$/, '');
}

// --- Lists ------------------------------------------------------------------------------

function listText(list: SnapElement, ctx: Ctx): string {
  const ordered = list.tag === 'ol';
  const step = list.a?.reversed ? -1 : 1;
  let number = list.a?.start ?? 1;
  const lines: string[] = [];
  for (const item of listItems(list)) {
    if (item.a?.value !== undefined) number = item.a.value;
    const marker = ordered ? `${number}.` : (ctx.options.bullet ?? '-');
    number += step;
    const value = listItemText(item, marker, ctx);
    if (value) lines.push(value);
  }
  return lines.join('\n');
}

function listItemText(item: SnapElement, marker: string, ctx: Ctx): string {
  const body = joinBlocks(blocks(item.c, { ...ctx, compact: true }));
  if (!body.trim()) return '';
  const indent = ' '.repeat(marker.length + 1);
  return body
    .split('\n')
    .map((line, index) => (index === 0 ? `${marker} ${line}` : line ? indent + line : ''))
    .join('\n');
}

/**
 * Items of a list, tolerating common invalid markup: a nested list placed directly inside
 * the list belongs to the previous item, wrapper elements around <li>s are looked through.
 */
export function listItems(list: SnapElement): SnapElement[] {
  const items: SnapElement[] = [];
  for (const child of list.c) {
    if (!isElement(child)) {
      if (child.v.trim()) items.push(el('li', null, child));
      continue;
    }
    if (child.tag === 'li') {
      items.push(child);
    } else if (child.tag === 'ul' || child.tag === 'ol') {
      const previous = items[items.length - 1];
      if (previous) items[items.length - 1] = { ...previous, c: [...previous.c, child] };
      else items.push(el('li', null, child));
    } else if (child.c.some((grandchild) => isElement(grandchild) && grandchild.tag === 'li')) {
      items.push(...listItems(child));
    } else {
      items.push(el('li', null, child));
    }
  }
  return items;
}

// --- Tables -----------------------------------------------------------------------------

function tableText(table: SnapElement, ctx: Ctx): string {
  const data = extractTableData(buildTableModel(table), (cell) => plainCellText(cell, ctx.options), 'first');
  return data.rows.map((row) => row.map((value) => value.replace(/\s*\n\s*/g, ' ')).join('\t')).join('\n');
}
