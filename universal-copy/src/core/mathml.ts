/**
 * Math as LaTeX. Pages render formulas with KaTeX or MathJax, which keep the TeX source
 * next to the output (KaTeX in a MathML annotation, MathJax 2 in a <script type="math/tex">,
 * MathJax 3/4 in data-latex); src/page/math.ts finds it. When only MathML is available
 * (MathJax's assistive MathML, plain <math>), `mathmlToLatex` rebuilds LaTeX from it.
 * Pure: MathML arrives as a plain tree.
 */

export interface MathNode {
  /** Lowercase MathML tag name (without a namespace prefix). */
  tag: string;
  /** Text of token elements (mi, mn, mo, mtext, ms). */
  text?: string;
  attrs?: Record<string, string>;
  children: MathNode[];
}

/**
 * Tidies TeX from a page: drops Wikipedia's `{\displaystyle ...}` / `{\textstyle ...}`
 * wrapper, trims, and (for inline math) puts it on one line.
 */
export function cleanTex(raw: string, display: boolean): string {
  let tex = raw.replace(/\r\n?/g, '\n').trim();
  const wrapped = /^\{\\(?:displaystyle|textstyle)\s*([\s\S]*)\}$/.exec(tex);
  if (wrapped?.[1] !== undefined && balanced(wrapped[1])) tex = wrapped[1].trim();
  if (!display) tex = tex.replace(/\s*\n\s*/g, ' ');
  else tex = tex.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n');
  return tex;
}

function balanced(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

// --- MathML → LaTeX --------------------------------------------------------------------------

const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta',
  ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ϖ: '\\varpi', ρ: '\\rho',
  σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\phi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi',
  Ψ: '\\Psi', Ω: '\\Omega',
};

const SYMBOLS: Record<string, string> = {
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '∗': '\\ast', '−': '-', '≤': '\\leq',
  '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '≅': '\\cong', '∝': '\\propto', '→': '\\to',
  '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '√': '\\surd',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊆': '\\subseteq', '⊃': '\\supset', '⊇': '\\supseteq', '∪': '\\cup',
  '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '¬': '\\neg', '∧': '\\land', '∨': '\\lor', '⊕': '\\oplus',
  '⊗': '\\otimes', '∘': '\\circ', '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '′': "'", '″': "''", '°': '^\\circ',
  '⟨': '\\langle', '⟩': '\\rangle', '‖': '\\|', '∣': '\\mid', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', 'ℓ': '\\ell', 'ℏ': '\\hbar',
  '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', '&': '\\&', '$': '\\$', '_': '\\_', '⁡': '', '⁢': '', '⁣': '', '⁤': '',
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim',
  'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'gcd', 'deg', 'arg', 'Pr',
]);

const ACCENTS: Record<string, string> = {
  '^': '\\hat', ˆ: '\\hat', '~': '\\tilde', '˜': '\\tilde', '¯': '\\bar', '‾': '\\overline', '→': '\\vec', '⃗': '\\vec', '˙': '\\dot',
  '¨': '\\ddot', '⏞': '\\overbrace', '⏟': '\\underbrace', _: '\\underline',
};

/** Relations and binary operators get spaces around them, like hand-written TeX. */
const SPACED = new Set(['=', '+', '-', '−', '<', '>', '≤', '≥', '≠', '≈', '≡', '∼', '≅', '∝', '±', '∓', '×', '÷', '·', '⋅', '→', '←', '↔', '⇒', '⇐', '⇔', '↦', '∈', '∉', '⊂', '⊆', '⊃', '⊇', '∪', '∩', '∧', '∨']);

const BIG_OPERATORS = new Set(['\\sum', '\\prod', '\\int', '\\oint', '\\lim', '\\max', '\\min', '\\sup', '\\inf']);

function symbol(ch: string): string {
  return GREEK[ch] ?? SYMBOLS[ch] ?? ch;
}

function tokenText(value: string): string {
  let out = '';
  for (const ch of value) out = join(out, symbol(ch));
  return out;
}

/** Concatenates LaTeX pieces, with a space where a command would run into a letter. */
function join(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return /\\[A-Za-z]+$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : left + right;
}

/** A superscript/subscript or command argument: braces unless it is one token. */
function group(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 1 || /^\\[A-Za-z]+$/.test(trimmed) || /^\d+$/.test(trimmed)) return trimmed;
  return `{${trimmed}}`;
}

/** The base of a script: a command with one argument (\mathrm{SS}, \hat{y}) needs no extra braces. */
function base(value: string): string {
  const trimmed = value.trim();
  return /^\\[A-Za-z]+\{[^{}]*\}$/.test(trimmed) ? trimmed : group(trimmed);
}

function children(node: MathNode): string {
  return node.children.reduce((out, child) => join(out, convert(child)), '');
}

function nth(node: MathNode, index: number): string {
  const child = node.children[index];
  return child ? convert(child) : '';
}

function convert(node: MathNode): string {
  switch (node.tag) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'menclose':
    case 'merror':
    case 'maction':
      return children(node);
    case 'semantics': {
      const tex = node.children.find((child) => child.tag === 'annotation' && /tex/i.test(child.attrs?.encoding ?? ''));
      if (tex?.text?.trim()) return tex.text.trim();
      const first = node.children.find((child) => child.tag !== 'annotation' && child.tag !== 'annotation-xml');
      return first ? convert(first) : '';
    }
    case 'annotation':
    case 'annotation-xml':
    case 'mphantom':
    case 'none':
    case 'mprescripts':
      return '';
    case 'mi': {
      const value = (node.text ?? '').trim();
      if (FUNCTIONS.has(value)) return `\\${value}`;
      if ([...value].length > 1) return `\\mathrm{${value}}`;
      const variant = node.attrs?.mathvariant;
      const letter = tokenText(value);
      if (variant === 'bold') return `\\mathbf{${letter}}`;
      if (variant === 'double-struck') return `\\mathbb{${letter}}`;
      if (variant === 'script') return `\\mathcal{${letter}}`;
      if (variant === 'normal' && /^[A-Za-z]$/.test(value)) return `\\mathrm{${value}}`;
      return letter;
    }
    case 'mn':
      return tokenText((node.text ?? '').trim());
    case 'mo': {
      const value = (node.text ?? '').trim();
      if (FUNCTIONS.has(value)) return `\\${value}`;
      if (SPACED.has(value)) return ` ${tokenText(value)} `;
      if (value === ',') return ', ';
      return tokenText(value);
    }
    case 'mtext':
    case 'ms': {
      const value = (node.text ?? '').replace(/\s+/g, ' ');
      return value.trim() ? `\\text{${value.replace(/[{}\\]/g, '\\$&')}}` : ' ';
    }
    case 'mspace':
      return ' ';
    case 'msup':
      return `${base(nth(node, 0))}^${group(nth(node, 1))}`;
    case 'msub':
      return `${base(nth(node, 0))}_${group(nth(node, 1))}`;
    case 'msubsup':
      return `${base(nth(node, 0))}_${group(nth(node, 1))}^${group(nth(node, 2))}`;
    case 'mfrac':
      return node.attrs?.linethickness === '0' ? `\\binom{${nth(node, 0)}}{${nth(node, 1)}}` : `\\frac{${nth(node, 0)}}{${nth(node, 1)}}`;
    case 'msqrt':
      return `\\sqrt{${children(node)}}`;
    case 'mroot':
      return `\\sqrt[${nth(node, 1)}]{${nth(node, 0)}}`;
    case 'mfenced': {
      const open = node.attrs?.open ?? '(';
      const close = node.attrs?.close ?? ')';
      const separator = (node.attrs?.separators ?? ',').trim().charAt(0) || ',';
      const inner = node.children.map(convert).join(separator);
      return `\\left${fence(open)}${inner}\\right${fence(close)}`;
    }
    case 'mover':
    case 'munder': {
      const base = nth(node, 0);
      const mark = (node.children[1]?.text ?? '').trim();
      const accent = ACCENTS[mark];
      if (accent && (node.tag === 'mover' || mark === '_' || mark === '⏟')) return `${accent}{${base}}`;
      if (BIG_OPERATORS.has(base.trim())) return `${base}${node.tag === 'mover' ? '^' : '_'}${group(nth(node, 1))}`;
      return `\\${node.tag === 'mover' ? 'overset' : 'underset'}{${nth(node, 1)}}{${base}}`;
    }
    case 'munderover': {
      const base = nth(node, 0);
      if (BIG_OPERATORS.has(base.trim()) || /^[∑∏∫]$/.test(node.children[0]?.text ?? '')) {
        return `${base}_${group(nth(node, 1))}^${group(nth(node, 2))}`;
      }
      return `\\overset{${nth(node, 2)}}{\\underset{${nth(node, 1)}}{${base}}}`;
    }
    case 'mtable': {
      const rows = node.children.filter((row) => row.tag === 'mtr' || row.tag === 'mlabeledtr');
      const body = rows.map((row) => row.children.filter((cell) => cell.tag === 'mtd').map(convert).join(' & ')).join(' \\\\ ');
      return `\\begin{matrix} ${body} \\end{matrix}`;
    }
    case 'mtr':
    case 'mlabeledtr':
      return node.children.map(convert).join(' & ');
    case 'mtd':
      return children(node);
    default:
      return node.text !== undefined ? tokenText(node.text) : children(node);
  }
}

function fence(value: string): string {
  if (!value) return '.';
  if (value === '{') return '\\{';
  if (value === '}') return '\\}';
  return symbol(value);
}

/**
 * A formula in Markdown's math syntax (GitHub, Obsidian, Jupyter, Typora...): `$x^2$` inline,
 * `$$` fences around display math. Clean text and HTML use the same delimiters.
 */
export function formatMath(tex: string, display: boolean): string {
  const value = tex.trim();
  if (!value) return '';
  return display ? `$$\n${value}\n$$` : `$${value.replace(/\s*\n\s*/g, ' ')}$`;
}

/** LaTeX for a MathML tree (a <math> element or any part of one). */
export function mathmlToLatex(node: MathNode): string {
  return convert(node)
    .replace(/\s{2,}/g, ' ')
    .replace(/([{(\[^_]) /g, '$1')
    .replace(/([{(\[^_])([-+]) /g, '$1$2')
    .replace(/ ([})\]])/g, '$1')
    .trim();
}
