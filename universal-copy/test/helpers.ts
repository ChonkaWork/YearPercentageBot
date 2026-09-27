import type { SnapNode } from '../src/core/snapshot';
import { snapshotSelection } from '../src/page/reader';

/** Puts HTML into the jsdom document. Relative URLs resolve against https://example.com/docs/. */
export function render(html: string, head = ''): void {
  document.head.innerHTML = `<base href="https://example.com/docs/">${head}`;
  document.body.innerHTML = html;
}

export function selectContents(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  select(range);
}

export function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  select(range);
}

function select(range: Range): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('no selection support');
  selection.removeAllRanges();
  selection.addRange(range);
}

export function $(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

/** First text node inside an element. */
export function textIn(selector: string): Text {
  const walker = document.createTreeWalker($(selector), NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) throw new Error(`No text in ${selector}`);
  return node as Text;
}

/** Renders HTML, selects the whole body and returns the selection snapshot's nodes. */
export function snapshotOf(html: string, head = ''): SnapNode[] {
  render(html, head);
  selectContents(document.body);
  const snapshot = snapshotSelection(document);
  if (snapshot.kind !== 'dom') throw new Error(`Expected a DOM selection, got ${snapshot.kind}`);
  return snapshot.nodes;
}
