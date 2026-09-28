/**
 * Converts a rendered chat message (a live DOM subtree) to Markdown or to plain text.
 *
 * Only standard DOM interfaces are used (no layout, no computed styles), so the same code runs
 * in the content script and in unit tests. Site-specific knowledge stays in src/sites/; the
 * adapters pass extra "UI chrome" selectors through `skip`.
 *
 * Whitespace works like the browser's: runs of spaces collapse unless an element uses
 * `white-space: pre*` (Tailwind's `whitespace-pre-wrap`, used for user messages). Internally,
 * whitespace that must survive collapsing is written as private-use sentinels and turned back
 * into spaces and line breaks when a paragraph is finished.
 */

export type Flavor = 'markdown' | 'text';

export interface ConvertOptions {
  flavor?: Flavor;
  /** Extra CSS selector for site UI inside messages that must be dropped. */
  skip?: string;
  /** Base for resolving relative links and image sources. */
  baseUrl?: string;
  /** Replace code blocks (`<pre>`) with a short "(Code block omitted.)" note. Inline code is kept. */
  omitCode?: boolean;
}

/** What an omitted code block becomes. */
export const CODE_OMITTED = '(Code block omitted.)';

/** Collapsing-proof space (pre-wrap text, inline code). */
const KEEP_SPACE = '\ue000';
/** Hard line break (`<br>`, newline in pre-wrap text). */
const BREAK = '\ue001';
const SENTINELS = /[\ue000\ue001]/g;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** UI chrome that never belongs to message content, on any site. */
const DEFAULT_SKIP = [
  'button',
  'svg',
  'style',
  'script',
  'noscript',
  'template',
  'textarea',
  'select',
  'iframe',
  'canvas',
  'video',
  'audio',
  'object',
  'embed',
  '[hidden]',
  '[aria-hidden="true"]',
  '[role="button"]',
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="tooltip"]',
  '.sr-only',
].join(',');

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',');

/** Inline elements that are never promoted to blocks, even when they wrap block markup. */
const INLINE_ONLY = new Set(['a', 'b', 'strong', 'em', 'i', 'del', 's', 'strike', 'code', 'kbd', 'samp', 'tt']);

/** Short labels in code block headers that are UI, not a language name. */
const UI_LABELS = new Set(['copy', 'copy code', 'copied', 'copied!', 'edit', 'run', 'download', 'code', 'wrap', 'expand', 'collapse']);

type BlockKind = 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'table' | 'rule' | 'math';

interface Block {
  kind: BlockKind;
  text: string;
}

interface Context {
  /** Inside an element with `white-space: pre*`: keep spaces and newlines. */
  pre: boolean;
  /** Inside a link: images render as their alt text (no nested links). */
  inLink: boolean;
}

export function htmlToMarkdown(root: Node | readonly Node[], options: Omit<ConvertOptions, 'flavor'> = {}): string {
  return new Converter({ ...options, flavor: 'markdown' }).convert(root);
}

export function htmlToText(root: Node | readonly Node[], options: Omit<ConvertOptions, 'flavor'> = {}): string {
  return new Converter({ ...options, flavor: 'text' }).convert(root);
}

class Converter {
  private readonly markdown: boolean;
  private readonly skip: string;
  private readonly baseUrl: string | undefined;
  private readonly omitCode: boolean;
  /** Language labels rendered next to code blocks: used for the fence, never as text. */
  private readonly labels = new Map<Element, string>();

  constructor(options: ConvertOptions) {
    this.markdown = (options.flavor ?? 'markdown') === 'markdown';
    this.skip = options.skip ? `${DEFAULT_SKIP},${options.skip}` : DEFAULT_SKIP;
    this.baseUrl = options.baseUrl;
    this.omitCode = options.omitCode ?? false;
  }

  convert(root: Node | readonly Node[]): string {
    const roots = Array.isArray(root) ? root : [root as Node];
    for (const node of roots) {
      if (node.nodeType !== ELEMENT_NODE) continue;
      const element = node as Element;
      const pres = element.localName === 'pre' ? [element] : Array.from(element.querySelectorAll('pre'));
      for (const pre of pres) {
        const label = precedingLabel(pre);
        if (label) this.labels.set(pre, label.text).set(label.element, label.text);
      }
    }
    const blocks: Block[] = [];
    for (const node of roots) {
      if (node.nodeType === ELEMENT_NODE && !this.isSkipped(node as Element)) {
        const element = node as Element;
        blocks.push(...(this.isBlock(element) ? this.block(element, this.contextFor(element, baseContext())) : this.blocksOf([element], baseContext())));
      } else if (node.nodeType === TEXT_NODE) {
        blocks.push(...this.blocksOf([node], baseContext()));
      }
    }
    return joinBlocks(blocks).replace(/^\n+/, '').trimEnd();
  }

  // --- Blocks ---------------------------------------------------------------------------------

  /** Renders a run of sibling nodes: inline content becomes paragraphs between the blocks. */
  private blocksOf(nodes: Iterable<Node>, context: Context): Block[] {
    const blocks: Block[] = [];
    let inline = '';
    const flush = () => {
      blocks.push(...this.paragraphs(inline));
      inline = '';
    };
    for (const node of nodes) {
      if (node.nodeType === TEXT_NODE) {
        inline += this.text(node.nodeValue ?? '', context);
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const element = node as Element;
      if (this.isSkipped(element)) continue;
      if (this.isBlock(element)) {
        flush();
        blocks.push(...this.block(element, this.contextFor(element, context)));
      } else {
        inline += this.inline(element, context);
      }
    }
    flush();
    return blocks;
  }

  private block(element: Element, context: Context): Block[] {
    const tag = element.localName;
    if (isDisplayMath(element)) return [{ kind: 'math', text: `$$\n${texOf(element)}\n$$` }];
    if (/^h[1-6]$/.test(tag)) return this.heading(element, Number(tag[1]), context);
    switch (tag) {
      case 'pre':
        return [this.codeBlock(element)];
      case 'ul':
      case 'ol':
        return this.list(element, context);
      case 'blockquote':
        return this.quote(element, context);
      case 'table':
        return this.table(element, context);
      case 'hr':
        return [{ kind: 'rule', text: '---' }];
      default:
        return this.blocksOf(element.childNodes, context);
    }
  }

  private heading(element: Element, level: number, context: Context): Block[] {
    const content = this.finishInline(this.inlineChildren(element, context)).replace(/\s*\n\s*/g, ' ').trim();
    if (!content) return [];
    return [{ kind: 'heading', text: this.markdown ? `${'#'.repeat(level)} ${content}` : content }];
  }

  private codeBlock(pre: Element): Block {
    if (this.omitCode) return { kind: 'paragraph', text: this.markdown ? `*${CODE_OMITTED}*` : CODE_OMITTED };
    const code = pre.querySelector('code');
    let text: string;
    if (code) {
      text = code.textContent ?? '';
    } else {
      const lines = pre.querySelectorAll('.cm-line');
      text = lines.length > 0 ? Array.from(lines, (line) => line.textContent ?? '').join('\n') : this.visibleText(pre);
    }
    text = text.replace(/\r\n?/g, '\n').replace(SENTINELS, '').replace(/\n$/, '');
    if (!this.markdown) return { kind: 'code', text };
    const language = codeLanguage(pre, code, this.skip, this.labels.get(pre) ?? null);
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return { kind: 'code', text: `${fence}${language}\n${text}\n${fence}` };
  }

  private list(element: Element, context: Context): Block[] {
    const ordered = element.localName === 'ol';
    let number = ordered ? Number.parseInt(element.getAttribute('start') ?? '1', 10) : 1;
    if (!Number.isFinite(number)) number = 1;
    const items: Block[][] = [];
    for (const child of Array.from(element.children)) {
      if (this.isSkipped(child)) continue;
      if (child.localName === 'li') {
        items.push(this.blocksOf(child.childNodes, this.contextFor(child, context)));
      } else if (child.localName === 'ul' || child.localName === 'ol') {
        // Invalid but common: a nested list directly inside the parent list.
        const nested = this.list(child, context);
        if (items.length > 0) items[items.length - 1]?.push(...nested);
        else items.push(nested);
      }
    }
    if (items.length === 0) return [];
    const loose = items.some((blocks) => blocks.filter((block) => block.kind !== 'list').length > 1);
    const rendered = items.map((blocks) => {
      const marker = ordered ? `${number++}.` : '-';
      const indent = ' '.repeat(marker.length + 1);
      if (blocks.length === 0) return marker;
      let out = '';
      blocks.forEach((block, index) => {
        const body = indentLines(block.text, indent);
        if (index === 0) {
          out = `${marker} ${body.slice(indent.length)}`;
        } else {
          const tight = block.kind === 'list' && blocks[index - 1]?.kind === 'paragraph' && !loose;
          out += `${tight ? '\n' : '\n\n'}${body}`;
        }
      });
      return out;
    });
    return [{ kind: 'list', text: rendered.join(loose ? '\n\n' : '\n') }];
  }

  private quote(element: Element, context: Context): Block[] {
    const inner = joinBlocks(this.blocksOf(element.childNodes, context));
    if (!inner.trim()) return [];
    return [{ kind: 'quote', text: inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n') }];
  }

  private table(table: Element, context: Context): Block[] {
    const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
    const matrix = rows
      .map((row) =>
        Array.from(row.children)
          .filter((cell) => cell.localName === 'td' || cell.localName === 'th')
          .map((cell) => {
            const content = this.finishInline(this.inlineChildren(cell, { ...context, pre: false }))
              .replace(/\s*\n\s*/g, ' ')
              .trim();
            return this.markdown ? content.replace(/\|/g, '\\|') : content;
          }),
      )
      .filter((cells) => cells.length > 0);
    if (matrix.length === 0) return [];
    const columns = Math.max(...matrix.map((cells) => cells.length));
    const padded = matrix.map((cells) => [...cells, ...Array<string>(columns - cells.length).fill('')]);
    if (!this.markdown) return [{ kind: 'table', text: padded.map((cells) => cells.join(' | ').trimEnd()).join('\n') }];

    const headerCells = Array.from(rows[0]?.children ?? []).filter((cell) => cell.localName === 'td' || cell.localName === 'th');
    const delimiter = Array.from({ length: columns }, (_, index) => alignmentMarker(headerCells[index]));
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const [header = [], ...body] = padded;
    return [{ kind: 'table', text: [line(header), line(delimiter), ...body.map(line)].join('\n') }];
  }

  /** Finishes a run of inline Markdown into paragraphs. Blank lines in pre-wrap text split paragraphs. */
  private paragraphs(inline: string): Block[] {
    const text = this.finishInline(inline);
    if (!text.trim()) return [];
    return text
      .split(/\n[ \t]*\n+/)
      .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
      .filter((paragraph) => paragraph.trim() !== '')
      .map((paragraph) => ({ kind: 'paragraph' as const, text: paragraph }));
  }

  /** Collapses whitespace, resolves sentinels, escapes line starts. Hard breaks become `\n` (text) or `  \n` (Markdown). */
  private finishInline(inline: string): string {
    const lines = inline
      .replace(/ {2,}/g, ' ')
      .split(BREAK)
      .map((line) => line.replace(/^ +| +$/g, '').replace(/\ue000/g, ' ').replace(/[ \t]+$/, ''));
    // Leading/trailing breaks (e.g. a <br> at the end of a paragraph) carry no meaning.
    while (lines.length > 1 && lines[0] === '') lines.shift();
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (!this.markdown) return lines.join('\n');
    const escaped = lines.map(escapeLineStart);
    let out = '';
    escaped.forEach((line, index) => {
      if (index === 0) out = line;
      else {
        const previous = escaped[index - 1] ?? '';
        // An empty line is a paragraph break; otherwise a Markdown hard break.
        out += line === '' || previous === '' ? `\n${line}` : `  \n${line}`;
      }
    });
    return out;
  }

  // --- Inline ---------------------------------------------------------------------------------

  private inlineChildren(element: Element, context: Context): string {
    let out = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === TEXT_NODE) out += this.text(node.nodeValue ?? '', context);
      else if (node.nodeType === ELEMENT_NODE && !this.isSkipped(node as Element)) out += this.inline(node as Element, context);
    }
    return out;
  }

  private inline(element: Element, parent: Context): string {
    if (isMath(element)) {
      const tex = texOf(element);
      if (!tex) return '';
      return isDisplayMath(element) ? `${BREAK}$$${tex}$$${BREAK}` : `$${tex.replace(/\s+/g, ' ')}$`;
    }
    const context = this.contextFor(element, parent);
    const tag = element.localName;
    switch (tag) {
      case 'br':
        return BREAK;
      case 'strong':
      case 'b':
        return this.wrap(this.inlineChildren(element, context), '**');
      case 'em':
      case 'i':
        return this.wrap(this.inlineChildren(element, context), '*');
      case 'del':
      case 's':
      case 'strike':
        return this.wrap(this.inlineChildren(element, context), '~~');
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return this.inlineCode(element.textContent ?? '');
      case 'a':
        return this.link(element, context);
      case 'img':
        return this.image(element, context);
      case 'input':
        if (element.getAttribute('type') === 'checkbox') return element.hasAttribute('checked') ? '[x] ' : '[ ] ';
        return '';
      default:
        if (BLOCK_TAGS.has(tag)) {
          // A block inside an inline element (e.g. a paragraph in a link): flatten it.
          return ` ${this.inlineChildren(element, context)} `;
        }
        return this.inlineChildren(element, context);
    }
  }

  private text(value: string, context: Context): string {
    let text = value.replace(SENTINELS, '');
    if (context.pre) {
      text = text.replace(/\r\n?/g, '\n');
      if (this.markdown) text = escapeMarkdown(text);
      return text.replace(/ /g, KEEP_SPACE).replace(/\t/g, `${KEEP_SPACE}${KEEP_SPACE}${KEEP_SPACE}${KEEP_SPACE}`).replace(/\n/g, BREAK);
    }
    text = text.replace(/[ \t\n\r\f]+/g, ' ');
    return this.markdown ? escapeMarkdown(text) : text;
  }

  private wrap(content: string, marker: string): string {
    if (!this.markdown) return content;
    const match = /^([\s\ue000\ue001]*)([\s\S]*?)([\s\ue000\ue001]*)$/.exec(content);
    const [, lead = '', inner = '', trail = ''] = match ?? [];
    if (!inner) return content;
    return `${lead}${marker}${inner}${marker}${trail}`;
  }

  private inlineCode(raw: string): string {
    const code = raw.replace(SENTINELS, '').replace(/[\r\n]+/g, ' ');
    if (!code.trim()) return code ? ' ' : '';
    if (!this.markdown) return code.replace(/ /g, KEEP_SPACE);
    const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(longestRun + 1);
    const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${code}${pad}${fence}`.replace(/ /g, KEEP_SPACE);
  }

  private link(element: Element, context: Context): string {
    const content = this.inlineChildren(element, { ...context, inLink: true });
    const href = safeUrl(element.getAttribute('href'), this.baseUrl, ['http:', 'https:', 'mailto:']);
    if (!href) return content;
    const match = /^([\s\ue000\ue001]*)([\s\S]*?)([\s\ue000\ue001]*)$/.exec(content);
    const [, lead = '', label = '', trail = ''] = match ?? [];
    if (!this.markdown) {
      if (!label) return `${lead}${href}${trail}`;
      if (sameUrl(label, href)) return content;
      return `${lead}${label} (${href})${trail}`;
    }
    if (!label) return content;
    if (sameUrl(unescapeMarkdown(label), href)) return `${lead}<${href}>${trail}`;
    return `${lead}[${label}](${linkDestination(href)})${trail}`;
  }

  private image(element: Element, context: Context): string {
    const alt = (element.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
    if (context.inLink) return this.markdown ? escapeMarkdown(alt) : alt;
    const src = safeUrl(element.getAttribute('src'), this.baseUrl, ['http:', 'https:']);
    const label = alt ? `Image: ${alt}` : 'Image';
    if (!this.markdown) return src ? `[${label}] (${src})` : `[${label}]`;
    return src ? `[${escapeMarkdown(label)}](${linkDestination(src)})` : `\\[${escapeMarkdown(label)}\\]`;
  }

  // --- Helpers --------------------------------------------------------------------------------

  private isSkipped(element: Element): boolean {
    if (isMath(element)) return false;
    if (this.labels.has(element) && element.localName !== 'pre') return true;
    if (element.localName === 'input') return element.getAttribute('type') !== 'checkbox';
    const style = element.getAttribute('style');
    if (style && /display\s*:\s*none/i.test(style)) return true;
    return element.matches(this.skip);
  }

  private isBlock(element: Element): boolean {
    if (isMath(element)) return isDisplayMath(element);
    const tag = element.localName;
    if (BLOCK_TAGS.has(tag)) return true;
    if (INLINE_ONLY.has(tag)) return false;
    // Unknown or inline wrappers (span, custom elements) that contain blocks act as blocks.
    return element.querySelector(BLOCK_SELECTOR) !== null;
  }

  private contextFor(element: Element, parent: Context): Context {
    const whiteSpace = whiteSpaceOf(element);
    if (whiteSpace === undefined) return parent;
    return { ...parent, pre: whiteSpace };
  }

  /** Text of an element without UI chrome (buttons, labels): for code blocks without <code>. */
  private visibleText(element: Element): string {
    const clone = element.cloneNode(true) as Element;
    for (const chrome of Array.from(clone.querySelectorAll(this.skip))) chrome.remove();
    return clone.textContent ?? '';
  }
}

function baseContext(): Context {
  return { pre: false, inLink: false };
}

function joinBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n');
}

/** true: keep whitespace (pre, pre-wrap, pre-line); false: collapse; undefined: inherit. */
function whiteSpaceOf(element: Element): boolean | undefined {
  const style = element.getAttribute('style');
  const inline = style ? /white-space\s*:\s*([\w-]+)/i.exec(style)?.[1]?.toLowerCase() : undefined;
  if (inline) return inline.startsWith('pre') || inline === 'break-spaces';
  const className = element.getAttribute('class');
  if (className) {
    if (/(?:^|\s)!?whitespace-(?:pre|pre-wrap|pre-line|break-spaces)!?(?:\s|$)/.test(className)) return true;
    if (/(?:^|\s)!?whitespace-(?:normal|nowrap)!?(?:\s|$)/.test(className)) return false;
  }
  return undefined;
}

// --- Math -------------------------------------------------------------------------------------

function isMath(element: Element): boolean {
  if (element.localName === 'math') return true;
  const classes = element.classList;
  return classes.contains('katex') || classes.contains('katex-display');
}

function isDisplayMath(element: Element): boolean {
  if (element.classList.contains('katex-display')) return true;
  if (element.localName === 'math') return element.getAttribute('display') === 'block';
  return element.classList.contains('katex') && element.parentElement?.classList.contains('katex-display') === true;
}

/** TeX source from KaTeX's MathML annotation; falls back to the MathML text. */
function texOf(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  const source = annotation?.textContent ?? element.querySelector('math')?.textContent ?? element.textContent ?? '';
  return source.replace(SENTINELS, '').trim();
}

// --- Code blocks ------------------------------------------------------------------------------

function codeLanguage(pre: Element, code: Element | null, skip: string, label: string | null): string {
  const fromClass = (element: Element | null) => {
    const match = /(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(element?.getAttribute('class') ?? '');
    return match?.[1] ?? element?.getAttribute('data-language') ?? null;
  };
  const language = fromClass(code) ?? fromClass(pre) ?? headerLabel(pre, code, skip) ?? label;
  return language ? language.toLowerCase().replace(/\s+/g, '-') : '';
}

/** A label inside <pre> but outside <code> (ChatGPT puts "python" in a header row there). */
function headerLabel(pre: Element, code: Element | null, skip: string): string | null {
  for (const element of Array.from(pre.querySelectorAll('div, span'))) {
    if (code && (code.contains(element) || element.contains(code))) continue;
    if (element.closest(skip)) continue;
    const label = asLanguageLabel(ownText(element));
    if (label) return label;
  }
  return null;
}

/**
 * A label right before the <pre> (Claude renders the language above the code, in a wrapper).
 * Climbs only through wrappers that hold nothing but the code, so an unrelated element before a
 * code block in the message is never taken for a label.
 */
function precedingLabel(pre: Element): { element: Element; text: string } | null {
  let current: Element = pre;
  for (let depth = 0; depth < 3; depth++) {
    const previous = current.previousElementSibling;
    if (previous && (previous.localName === 'div' || previous.localName === 'span')) {
      const text = asLanguageLabel(previous.textContent ?? '');
      if (text) return { element: previous, text };
    }
    const parent = current.parentElement;
    if (!parent || parent.children.length !== 1) return null;
    current = parent;
  }
  return null;
}

function ownText(element: Element): string {
  let text = '';
  for (const node of Array.from(element.childNodes)) if (node.nodeType === TEXT_NODE) text += node.nodeValue ?? '';
  return text;
}

function asLanguageLabel(raw: string): string | null {
  const text = raw.trim();
  if (!/^[A-Za-z][\w#+.-]{0,23}$/.test(text)) return null;
  if (UI_LABELS.has(text.toLowerCase())) return null;
  return text;
}

// --- Tables -----------------------------------------------------------------------------------

function alignmentMarker(cell: Element | undefined): string {
  const align = (cell?.getAttribute('align') ?? /text-align\s*:\s*(\w+)/i.exec(cell?.getAttribute('style') ?? '')?.[1] ?? '').toLowerCase();
  if (align === 'center') return ':---:';
  if (align === 'right') return '---:';
  if (align === 'left') return ':---';
  return '---';
}

// --- Escaping and URLs ------------------------------------------------------------------------

/**
 * Escapes text so Markdown renders it literally. Conservative about readability: `_` inside
 * words (snake_case) and `<` that can't start a tag (x < y) are left alone.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[*`[\]$]/g, '\\$&')
    // `_` only emphasizes at a word boundary, so snake_case stays readable.
    .replace(/_/g, (match, offset: number, whole: string) => (isWordChar(whole[offset - 1]) && isWordChar(whole[offset + 1]) ? match : '\\_'))
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/~~/g, '\\~\\~')
    .replace(/&(?=#?\w+;)/g, '&amp;');
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Escapes characters that would start a block (heading, list, quote, …) at the start of a line. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|(\d{1,9})([.)])(?=\s|$)|=+\s*$|-{2,}\s*$|~~~)/, (match, space: string, token: string, digits?: string, dot?: string) => {
    if (digits !== undefined && dot !== undefined) return `${space}${digits}\\${dot}`;
    return `${space}\\${token}`;
  });
}

function safeUrl(raw: string | null, base: string | undefined, protocols: readonly string[]): string | null {
  if (!raw) return null;
  try {
    const url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function linkDestination(url: string): string {
  return url.replace(/[ ()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function sameUrl(label: string, href: string): boolean {
  const strip = (value: string) => value.trim().replace(/^mailto:/, '').replace(/\/$/, '');
  return strip(label) === strip(href);
}
