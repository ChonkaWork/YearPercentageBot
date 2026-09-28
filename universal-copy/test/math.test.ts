// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { convertSelection } from '../src/core/convert';
import { toMarkdown } from '../src/core/markdown';
import { cleanTex, formatMath, mathmlToLatex, type MathNode } from '../src/core/mathml';
import { toPlainText } from '../src/core/plainText';
import { toCleanHtml } from '../src/core/html';
import { defaultSettings } from '../src/core/settings';
import { el } from '../src/core/snapshot';
import { snapshotSelection } from '../src/page/reader';
import fixture from '../e2e/fixtures/math.html?raw';
import { $, render, selectContents, selectRange } from './helpers';

const settings = defaultSettings('en-US');

/** The fixture's <body>, rendered into jsdom with its styles. */
function renderFixture(): void {
  const doc = new DOMParser().parseFromString(fixture, 'text/html');
  render(doc.body.innerHTML, doc.head.querySelector('style')?.outerHTML ?? '');
}

const markdown = () => convertSelection(snapshotSelection(document), 'markdown', settings).text;

/** A MathML tree from markup, the way src/page/math.ts builds it from the DOM. */
function mathml(markup: string): MathNode {
  const doc = new DOMParser().parseFromString(`<math xmlns="http://www.w3.org/1998/Math/MathML">${markup}</math>`, 'text/html');
  const convert = (element: Element): MathNode => {
    const tag = element.localName;
    const node: MathNode = { tag, children: [] };
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
    if (Object.keys(attrs).length) node.attrs = attrs;
    if (['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation'].includes(tag)) node.text = element.textContent ?? '';
    else node.children = Array.from(element.children).map(convert);
    return node;
  };
  const math = doc.querySelector('math');
  if (!math) throw new Error('no math');
  return convert(math);
}

describe('mathmlToLatex', () => {
  it('converts scripts, fractions, roots and Greek letters', () => {
    expect(mathmlToLatex(mathml('<msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msub><mi>α</mi><mi>i</mi></msub>'))).toBe('x^2 + \\alpha_i');
    expect(mathmlToLatex(mathml('<mfrac><mn>1</mn><mrow><mi>n</mi><mo>−</mo><mn>1</mn></mrow></mfrac>'))).toBe('\\frac{1}{n - 1}');
    expect(mathmlToLatex(mathml('<msqrt><mi>x</mi></msqrt><mroot><mi>y</mi><mn>3</mn></mroot>'))).toBe('\\sqrt{x}\\sqrt[3]{y}');
    expect(mathmlToLatex(mathml('<msubsup><mo>∫</mo><mn>0</mn><mi>∞</mi></msubsup><msup><mi>e</mi><mrow><mo>−</mo><mi>x</mi></mrow></msup><mi>d</mi><mi>x</mi>'))).toBe(
      '\\int_0^\\infty e^{-x}dx',
    );
  });

  it('handles accents, operators under/over and function names', () => {
    expect(mathmlToLatex(mathml('<mover accent="true"><mi>y</mi><mo>^</mo></mover>'))).toBe('\\hat{y}');
    expect(mathmlToLatex(mathml('<mover><mi>x</mi><mo>¯</mo></mover>'))).toBe('\\bar{x}');
    expect(mathmlToLatex(mathml('<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msub><mi>x</mi><mi>i</mi></msub>'))).toBe(
      '\\sum_{i = 1}^nx_i',
    );
    expect(mathmlToLatex(mathml('<mi>sin</mi><mi>θ</mi><mo>≤</mo><mn>1</mn>'))).toBe('\\sin\\theta \\leq 1');
    expect(mathmlToLatex(mathml('<mi mathvariant="double-struck">R</mi><mo>,</mo><mi mathvariant="script">N</mi>'))).toBe('\\mathbb{R}, \\mathcal{N}');
  });

  it('builds matrices and fenced groups, and prefers a TeX annotation', () => {
    expect(mathmlToLatex(mathml('<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable>'))).toBe(
      '\\begin{matrix} 1 & 0 \\\\ 0 & 1 \\end{matrix}',
    );
    expect(mathmlToLatex(mathml('<mfenced open="[" close="]"><mi>a</mi><mi>b</mi></mfenced>'))).toBe('\\left[a,b\\right]');
    expect(mathmlToLatex(mathml('<semantics><mi>x</mi><annotation encoding="application/x-tex">x_{\\text{max}}</annotation></semantics>'))).toBe('x_{\\text{max}}');
  });

  it('tidies TeX from pages and formats it for Markdown', () => {
    expect(cleanTex('{\\displaystyle y=mx+b}', false)).toBe('y=mx+b');
    expect(cleanTex('{\\displaystyle a} + {b}', false)).toBe('{\\displaystyle a} + {b}');
    expect(cleanTex('  a +\n  b ', false)).toBe('a + b');
    expect(cleanTex('\\begin{aligned}\n a &= b \\\\\n c &= d\n\\end{aligned}', true)).toBe('\\begin{aligned}\n a &= b \\\\\n c &= d\n\\end{aligned}');
    expect(formatMath('x^2', false)).toBe('$x^2$');
    expect(formatMath('x^2', true)).toBe('$$\nx^2\n$$');
    expect(formatMath('  ', true)).toBe('');
  });
});

describe('math in the converters', () => {
  const inline = el('math', { tex: 'x^2' });
  const display = el('math', { tex: 'E = mc^2', display: true });

  it('writes $…$ inline and $$ blocks in Markdown, text and HTML', () => {
    const nodes = [el('p', null, 'Area ', inline, ' grows.'), display, el('p', null, 'Done.')];
    expect(toMarkdown(nodes)).toBe('Area $x^2$ grows.\n\n$$\nE = mc^2\n$$\n\nDone.');
    expect(toPlainText(nodes)).toBe('Area $x^2$ grows.\n\n$$\nE = mc^2\n$$\n\nDone.');
    expect(toCleanHtml(nodes)).toBe('<p>Area $x^2$ grows.</p>\n<p>$$E = mc^2$$</p>\n<p>Done.</p>');
  });
});

describe('reading formulas from pages', () => {
  it('KaTeX, MathJax 2, MathJax 3 (data-latex and assistive MathML) become LaTeX', () => {
    renderFixture();
    selectContents($('#notes'));
    expect(markdown()).toBe(
      [
        '# Linear regression, step by step',
        'Dr. Lena Petrenko · 10 February 2026',
        'A simple linear model predicts $\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.',
        '## The slope',
        'Least squares picks the slope that minimises the squared errors:',
        '$$\n\\beta_1 = \\frac{\\sum_{i=1}^{n} (x_i - \\bar{x})(y_i - \\bar{y})}{\\sum_{i=1}^{n} (x_i - \\bar{x})^2}\n$$',
        '## Means',
        'Both sums use the sample mean $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$, and the same for $y$.',
        '## How good is the fit?',
        'The coefficient of determination compares the leftover error with the total variation:',
        '$$\nR^2 = 1 - \\frac{\\mathrm{SS}_{\\text{res}}}{\\mathrm{SS}_{\\text{tot}}}\n$$',
        'The errors are assumed to be normal, $\\varepsilon \\sim \\mathcal{N}(0, \\sigma^2)$, with the same variance for every observation.',
        'Exam tip: an $R^2$ close to 1 does not prove the model is right. Always look at the residuals.',
      ].join('\n\n'),
    );
  });

  it('never copies the rendered glyphs or the hidden MathML as text', () => {
    renderFixture();
    selectContents($('#notes'));
    const text = convertSelection(snapshotSelection(document), 'text', settings).text;
    for (const junk of ['ŷ', 'β₀', 'Σ', 'x̄', 'R²', 'SSres', 'ε ~']) expect(text).not.toContain(junk);
    expect(text).toContain('A simple linear model predicts $\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.');
  });

  it('copies the whole formula when the selection starts or ends inside it', () => {
    renderFixture();
    // From inside the rendered KaTeX output to the end of the paragraph.
    const inside = document.querySelector('#model .katex-html .base')?.firstChild as Text;
    const after = Array.from($('#model').childNodes).at(-1) as Text;
    selectRange(inside, 2, after, after.data.length);
    expect(markdown()).toBe('$\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.');
    // Only part of a formula.
    selectRange(inside, 1, inside, 4);
    expect(markdown()).toBe('$\\hat{y} = \\beta_0 + \\beta_1 x$');
  });

  it('reads Wikipedia math (alt text, displaystyle removed) and bare MathML', () => {
    render(
      '<p id="p">Line: <span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display: none;"><math alttext="{\\displaystyle y=mx+b}"><semantics><mrow><mi>y</mi></mrow><annotation encoding="application/x-tex">{\\displaystyle y=mx+b}</annotation></semantics></math></span><img class="mwe-math-fallback-image-inline" src="/media/math.svg" alt="{\\displaystyle y=mx+b}"></span> is a line.</p>' +
        '<p id="q">Bare: <math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>.</p>',
    );
    selectContents($('#p'));
    expect(markdown()).toBe('Line: $y=mx+b$ is a line.');
    selectContents($('#q'));
    expect(markdown()).toBe('Bare: $\\frac{a}{b}$.');
  });

  it('reads a MathJax 2 display formula and skips its loading preview', () => {
    render(
      '<p>Before</p><span class="MathJax_Preview">[math]</span><div class="MathJax_Display"><span class="MathJax" id="MathJax-Element-9-Frame"><nobr>rendered</nobr></span></div><script type="math/tex; mode=display" id="MathJax-Element-9">a^2 + b^2 = c^2</script><p>After</p>',
    );
    selectContents(document.body);
    expect(markdown()).toBe('Before\n\n$$\na^2 + b^2 = c^2\n$$\n\nAfter');
  });
});
