import { cleanTex, mathmlToLatex, type MathNode } from '../core/mathml';

/**
 * Finds the LaTeX behind formulas rendered by KaTeX, MathJax 2/3/4 and Wikipedia, or
 * rebuilds it from MathML. Their visual output is useless as copied text (glyph soup, or
 * CSS-generated characters) and is hidden from screen readers, so formulas used to vanish
 * from copies; now each becomes one `math` node with its TeX.
 */

/** Elements that hold one formula (the outermost match wins). */
export const MATH_SELECTOR = [
  '.katex-display',
  '.katex',
  'mjx-container',
  '.MathJax_Display',
  '.MathJax_SVG_Display',
  '.MathJax',
  '.MathJax_SVG',
  '.MathJax_CHTML',
  '.mwe-math-element',
  'math',
].join(', ');

export type MathRead = { tex: string; display: boolean } | 'skip' | null;

/**
 * The formula an element stands for, 'skip' for math markup that must not be copied as text
 * (loading previews, sources read from their rendered element), or null for anything else.
 */
export function readMath(element: Element): MathRead {
  const tag = element.localName.toLowerCase();
  const classes = element.classList;

  if (tag === 'script') {
    const type = element.getAttribute('type') ?? '';
    if (!/^\s*math\/tex/i.test(type)) return null;
    // MathJax 2 renders into "<id>-Frame" and the formula is read there.
    if (element.id && element.ownerDocument.getElementById(`${element.id}-Frame`)) return 'skip';
    return formula(element.textContent, /mode\s*=\s*display/i.test(type));
  }
  if (classes.contains('MathJax_Preview')) return 'skip';

  if (classes.contains('katex-display')) return fromTex(element, true) ?? 'skip';
  if (classes.contains('katex')) return fromTex(element, element.parentElement?.classList.contains('katex-display') === true) ?? 'skip';

  if (tag === 'mjx-container') {
    const display = element.getAttribute('display') === 'true' || element.getAttribute('display') === 'block';
    const latex = element.getAttribute('data-latex') ?? element.querySelector('math[data-latex]')?.getAttribute('data-latex');
    if (latex) return formula(latex, display);
    return fromTex(element, display) ?? 'skip';
  }

  if (
    classes.contains('MathJax_Display') ||
    classes.contains('MathJax_SVG_Display') ||
    classes.contains('MathJax') ||
    classes.contains('MathJax_SVG') ||
    classes.contains('MathJax_CHTML')
  ) {
    const frame = element.id.endsWith('-Frame') ? element : element.querySelector('[id$="-Frame"]');
    const source = frame ? element.ownerDocument.getElementById(frame.id.slice(0, -'-Frame'.length)) : null;
    if (source?.localName === 'script') {
      const display = classes.contains('MathJax_Display') || classes.contains('MathJax_SVG_Display') || /mode\s*=\s*display/i.test(source.getAttribute('type') ?? '');
      return formula(source.textContent, display);
    }
    return fromTex(element, classes.contains('MathJax_Display')) ?? 'skip';
  }

  if (classes.contains('mwe-math-element')) {
    const display = element.querySelector('.mwe-math-fallback-image-display, math[display="block"]') !== null;
    const alt = element.querySelector('math[alttext]')?.getAttribute('alttext') ?? element.querySelector('img[alt]')?.getAttribute('alt');
    if (alt) return formula(alt, display);
    return fromTex(element, display) ?? 'skip';
  }

  if (tag === 'math') {
    const display = element.getAttribute('display') === 'block';
    const alt = element.getAttribute('alttext');
    if (alt) return formula(alt, display);
    return fromTex(element, display) ?? 'skip';
  }
  return null;
}

/** The outermost formula container around a node (a selection can start inside one). */
export function outermostMath(element: Element | null): Element | null {
  let found: Element | null = null;
  for (let node = element?.closest(MATH_SELECTOR) ?? null; node; node = node.parentElement?.closest(MATH_SELECTOR) ?? null) found = node;
  return found;
}

function formula(raw: string | null | undefined, display: boolean): { tex: string; display: boolean } | null {
  const tex = cleanTex(raw ?? '', display);
  return tex ? { tex, display } : null;
}

/** TeX from a MathML annotation, otherwise LaTeX rebuilt from the MathML inside. */
function fromTex(container: Element, display: boolean): { tex: string; display: boolean } | null {
  const annotation = Array.from(container.querySelectorAll('annotation')).find((item) => /tex/i.test(item.getAttribute('encoding') ?? ''));
  if (annotation?.textContent?.trim()) return formula(annotation.textContent, display);
  const math = container.localName.toLowerCase() === 'math' ? container : container.querySelector('math');
  if (!math) return null;
  return formula(mathmlToLatex(toMathNode(math)), display || math.getAttribute('display') === 'block');
}

const TOKENS = new Set(['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation']);
const MATH_ATTRIBUTES = ['mathvariant', 'linethickness', 'open', 'close', 'separators', 'encoding', 'accent', 'display'];
const MAX_MATH_NODES = 5000;

function toMathNode(element: Element, budget = { left: MAX_MATH_NODES }): MathNode {
  const tag = element.localName.toLowerCase().replace(/^m:/, '');
  const node: MathNode = { tag, children: [] };
  const attrs: Record<string, string> = {};
  for (const name of MATH_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attrs[name] = value;
  }
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  if (TOKENS.has(tag)) node.text = element.textContent ?? '';
  else {
    for (const child of Array.from(element.children)) {
      if (--budget.left < 0) break;
      node.children.push(toMathNode(child, budget));
    }
  }
  return node;
}
