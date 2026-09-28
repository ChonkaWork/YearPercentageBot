import { el, headingLevel, isElement, textContent, type SnapElement, type SnapNode } from './snapshot';

/**
 * "Copy article": the main content of a page without selecting it, in the spirit of
 * Readability but small. Works on a whole-page snapshot (src/page/reader.ts
 * `snapshotDocument`), whose elements carry hint words from their id, class and role.
 *
 * 1. Site furniture is dropped: navigation, sidebars, headers and footers, ads, cookie and
 *    newsletter banners, share bars, related links, comments, fixed overlays.
 * 2. Every paragraph-like block scores points for its length and commas; its parent gets
 *    them in full, its grandparent half, and so on. Containers full of links lose points.
 * 3. The best container wins, together with siblings that score nearly as well (articles
 *    split over several <div>s). The page's <h1> is added when it sits outside the content.
 *
 * Headings, lists, code, tables, images, math and links inside the content are kept; the
 * converters turn the result into Markdown, text or HTML like any selection.
 */

export interface ArticleResult {
  nodes: SnapNode[];
  /** False when no container stood out and the cleaned page is returned whole. */
  found: boolean;
  /** Text of the article's <h1>, if it has one. */
  heading: string | null;
}

/**
 * Hint words for an element: its id and each class as a dash-separated name (`site-nav__item`
 * → `site-nav-item`, `shareBar` → `share-bar`), its ARIA roles as `@role`, and `@fixed` for
 * fixed or sticky elements (cookie banners, sticky headers, chat widgets).
 */
export function hintWords(id: string | null, className: string | null, role: string | null, fixed: boolean): string {
  const names = `${id ?? ''} ${className ?? ''}`
    .split(/\s+/)
    .map((name) =>
      name
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join('-'),
    )
    .filter((name) => name.length > 1 && name.length < 60);
  for (const value of (role ?? '').toLowerCase().split(/\s+/)) if (/^[a-z]+$/.test(value)) names.push(`@${value}`);
  if (fixed) names.push('@fixed');
  return [...new Set(names)].join(' ');
}

/** Tags that are never article content. */
const JUNK_TAGS = new Set(['nav', 'aside', 'footer', 'dialog', 'menu', 'search']);
const JUNK_ROLES = new Set(['@navigation', '@complementary', '@contentinfo', '@banner', '@search', '@dialog', '@alertdialog', '@menu', '@menubar', '@toolbar', '@tablist']);
const JUNK_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'sidebar', 'aside', 'footer', 'masthead', 'breadcrumb', 'breadcrumbs', 'toc', 'skip',
  'ad', 'ads', 'adslot', 'advert', 'advertisement', 'adsbygoogle', 'sponsor', 'sponsored', 'promo', 'promoted', 'outbrain', 'taboola',
  'cookie', 'cookies', 'consent', 'gdpr', 'newsletter', 'subscribe', 'subscription', 'signup', 'paywall', 'popup', 'modal', 'overlay',
  'share', 'sharing', 'social', 'related', 'recommended', 'recommendations', 'popular', 'trending', 'mostread', 'comment', 'comments',
  'disqus', 'feedback', 'pagination', 'pager', 'toolbar', 'widget', 'tags', 'tagcloud', '@fixed',
]);
const CONTENT_WORDS = new Set(['article', 'content', 'entry', 'main', 'post', 'story', 'body', 'text', 'prose', 'markdown', 'blog', 'docs', 'documentation']);

const PARAGRAPH_TAGS = new Set(['p', 'pre', 'blockquote', 'td', 'li', 'dd', 'figcaption']);
const MIN_PARAGRAPH = 25;

function names(node: SnapElement): string[] {
  return node.k ? node.k.split(' ') : [];
}

/**
 * How one class or id reads: `main-nav` and `article-footer` are furniture (the last word
 * names the thing), `post-content` and `article-body` are content, `ad-free` is furniture
 * unless another name says content.
 */
function nameKind(name: string): 'junk' | 'content' | null {
  if (name.startsWith('@')) return JUNK_WORDS.has(name) ? 'junk' : null;
  const parts = name.split('-');
  const last = parts[parts.length - 1] ?? '';
  if (JUNK_WORDS.has(last)) return 'junk';
  if (CONTENT_WORDS.has(last)) return 'content';
  if (parts.some((part) => JUNK_WORDS.has(part))) return parts.some((part) => CONTENT_WORDS.has(part)) ? null : 'junk';
  return parts.some((part) => CONTENT_WORDS.has(part)) ? 'content' : null;
}

function squashedLength(node: SnapNode): number {
  return textContent(node).replace(/\s+/g, ' ').trim().length;
}

function linkLength(node: SnapNode): number {
  if (!isElement(node)) return 0;
  if (node.tag === 'a') return squashedLength(node);
  return node.c.reduce((sum, child) => sum + linkLength(child), 0);
}

function linkDensity(node: SnapElement): number {
  const total = squashedLength(node);
  return total === 0 ? 0 : Math.min(1, linkLength(node) / total);
}

function contains(node: SnapElement, test: (child: SnapElement) => boolean): boolean {
  return node.c.some((child) => isElement(child) && (test(child) || contains(child, test)));
}

/** Furniture to drop before scoring. The article's own <header> (with its h1) is kept. */
function isJunk(node: SnapElement): boolean {
  const hints = names(node);
  if (hints.some((name) => JUNK_ROLES.has(name))) return true;
  if (JUNK_TAGS.has(node.tag)) return true;
  if (node.tag === 'header') {
    const hasHeading = contains(node, (child) => child.tag === 'h1' || child.tag === 'h2');
    return !hasHeading || linkDensity(node) > 0.5;
  }
  if (node.tag === 'form' && squashedLength(node) < 500) return true;
  if (hints.includes('@main') || hints.includes('@article')) return false;
  const kinds = hints.map(nameKind);
  return kinds.includes('junk') && !kinds.includes('content');
}

/** A copy of the tree without furniture and without empty containers. */
function clean(nodes: readonly SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  for (const node of nodes) {
    if (!isElement(node)) {
      out.push(node);
      continue;
    }
    if (isJunk(node)) continue;
    const children = clean(node.c);
    const copy: SnapElement = { ...node, c: children };
    const keepEmpty = node.tag === 'img' || node.tag === 'br' || node.tag === 'hr' || node.tag === 'math' || node.tag === 'td' || node.tag === 'th' || node.tag === 'input';
    if (!keepEmpty && children.length === 0 && !textContent(copy).trim()) continue;
    out.push(copy);
  }
  return out;
}

// --- Scoring --------------------------------------------------------------------------------

function classWeight(node: SnapElement): number {
  const hints = names(node);
  const kinds = hints.map(nameKind);
  let weight = 0;
  if (kinds.includes('content')) weight += 25;
  if (kinds.includes('junk')) weight -= 25;
  if (hints.includes('@main') || hints.includes('@article')) weight += 10;
  return weight;
}

function tagWeight(tag: string): number {
  switch (tag) {
    case 'article':
      return 20;
    case 'main':
      return 15;
    case 'section':
    case 'div':
      return 5;
    case 'pre':
    case 'td':
    case 'blockquote':
      return 3;
    case 'ul':
    case 'ol':
    case 'dl':
    case 'li':
    case 'form':
      return -3;
    default:
      return headingLevel(tag) > 0 || tag === 'th' ? -5 : 0;
  }
}

interface Scored {
  node: SnapElement;
  parent: SnapElement | null;
  score: number;
}

function scoreTree(root: SnapElement): { scores: Map<SnapElement, Scored>; parents: Map<SnapElement, SnapElement | null> } {
  const scores = new Map<SnapElement, Scored>();
  const parents = new Map<SnapElement, SnapElement | null>();
  const ensure = (node: SnapElement): Scored => {
    let entry = scores.get(node);
    if (!entry) {
      entry = { node, parent: parents.get(node) ?? null, score: tagWeight(node.tag) + classWeight(node) };
      scores.set(node, entry);
    }
    return entry;
  };
  const award = (from: SnapElement, points: number) => {
    let ancestor = parents.get(from) ?? null;
    for (let level = 0; ancestor && level < 5; level++, ancestor = parents.get(ancestor) ?? null) {
      const divider = level === 0 ? 1 : level === 1 ? 2 : level * 3;
      ensure(ancestor).score += points / divider;
    }
  };
  const points = (length: number, value: string) => 1 + (value.match(/[,，、،]/g)?.length ?? 0) + Math.min(3, Math.floor(length / 100));

  const walk = (node: SnapElement) => {
    let directText = '';
    for (const child of node.c) {
      if (isElement(child)) {
        parents.set(child, node);
        walk(child);
      } else directText += child.v;
    }
    if (PARAGRAPH_TAGS.has(node.tag)) {
      const value = textContent(node).replace(/\s+/g, ' ').trim();
      if (value.length >= MIN_PARAGRAPH && !(node.tag === 'li' && linkDensity(node) > 0.5)) award(node, points(value.length, value));
    } else {
      // Text sitting directly in a <div> (sites without <p> tags) counts as a paragraph of it.
      const value = directText.replace(/\s+/g, ' ').trim();
      if (value.length >= MIN_PARAGRAPH) {
        const self = ensure(node);
        self.score += points(value.length, value);
      }
    }
  };
  parents.set(root, null);
  walk(root);
  for (const entry of scores.values()) entry.score *= 1 - linkDensity(entry.node);
  return { scores, parents };
}

// --- Cleanup inside the article -------------------------------------------------------------

/** Link lists inside the content ("Read next", tag clouds without class names). */
function isLinkList(node: SnapElement): boolean {
  if (!['ul', 'ol', 'div', 'section', 'p'].includes(node.tag)) return false;
  let links = 0;
  const count = (current: SnapNode) => {
    if (!isElement(current)) return;
    if (current.tag === 'a') links++;
    else current.c.forEach(count);
  };
  count(node);
  if (links < 3) return false;
  return linkDensity(node) > 0.8 && !contains(node, (child) => child.tag === 'p' && linkDensity(child) < 0.5 && squashedLength(child) > 80);
}

function prune(nodes: readonly SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  for (const node of nodes) {
    if (!isElement(node)) {
      out.push(node);
      continue;
    }
    if (isLinkList(node)) continue;
    out.push({ ...node, c: prune(node.c) });
  }
  return out;
}

function stripHints(nodes: readonly SnapNode[]): SnapNode[] {
  return nodes.map((node) => {
    if (!isElement(node)) return node;
    const { k: _hints, ...rest } = node;
    return { ...rest, c: stripHints(node.c) };
  });
}

function findHeading(nodes: readonly SnapNode[]): SnapElement | null {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (node.tag === 'h1') return node;
    const nested = findHeading(node.c);
    if (nested) return nested;
  }
  return null;
}

/** Document order of elements, to find the h1 that comes before the content. */
function orderOf(root: SnapElement): Map<SnapElement, number> {
  const order = new Map<SnapElement, number>();
  let index = 0;
  const walk = (node: SnapElement) => {
    order.set(node, index++);
    for (const child of node.c) if (isElement(child)) walk(child);
  };
  walk(root);
  return order;
}

// --- Entry point ----------------------------------------------------------------------------

export function extractArticle(body: readonly SnapNode[]): ArticleResult {
  const root = el('body', null, ...clean(body));
  const { scores, parents } = scoreTree(root);
  let best: Scored | null = null;
  for (const entry of scores.values()) {
    if (entry.node === root) continue;
    if (!best || entry.score > best.score) best = entry;
  }

  if (!best || best.score < 10) {
    const nodes = stripHints(prune(root.c));
    const heading = findHeading(nodes);
    return { nodes, found: false, heading: heading ? oneLine(heading) : null };
  }

  // The body text of a story usually sits inside an <article> that also holds its headline,
  // standfirst, byline and lead image: take the whole <article>.
  let top = best.node;
  for (let ancestor = parents.get(top) ?? null; ancestor && ancestor !== root; ancestor = parents.get(ancestor) ?? null) {
    if ((ancestor.tag === 'article' || names(ancestor).includes('@article')) && linkDensity(ancestor) < 0.35) {
      top = ancestor;
      break;
    }
  }

  // Siblings that score nearly as well belong to the same article.
  const parent = parents.get(top) ?? null;
  let picked: SnapNode[] = [top];
  if (parent && parent !== root) {
    const threshold = Math.max(10, best.score * 0.2);
    picked = parent.c.filter((sibling) => {
      if (sibling === top) return true;
      if (!isElement(sibling)) return false;
      const score = scores.get(sibling)?.score ?? 0;
      if (score >= threshold) return true;
      return sibling.tag === 'p' && squashedLength(sibling) > 80 && linkDensity(sibling) < 0.25;
    });
  }

  let nodes = prune(picked);
  let heading = findHeading(nodes);
  if (!heading) {
    // The headline often sits in a header above the article body.
    const order = orderOf(root);
    const startsAt = order.get(top) ?? 0;
    const outside = findHeading(root.c);
    if (outside && (order.get(outside) ?? Infinity) < startsAt) {
      nodes = [outside, ...nodes];
      heading = outside;
    }
  }
  return { nodes: stripHints(nodes), found: true, heading: heading ? oneLine(heading) : null };
}

function oneLine(node: SnapElement): string {
  return textContent(node).replace(/\s+/g, ' ').trim();
}
