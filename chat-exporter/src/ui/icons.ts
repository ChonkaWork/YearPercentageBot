import arrowRepeat from 'bootstrap-icons/icons/arrow-repeat.svg';
import boxArrowUpRight from 'bootstrap-icons/icons/box-arrow-up-right.svg';
import chatSquareText from 'bootstrap-icons/icons/chat-square-text.svg';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg';
import clipboard from 'bootstrap-icons/icons/clipboard.svg';
import download from 'bootstrap-icons/icons/download.svg';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import fileEarmarkText from 'bootstrap-icons/icons/file-earmark-text.svg';
import filetypeJson from 'bootstrap-icons/icons/filetype-json.svg';
import filetypePdf from 'bootstrap-icons/icons/filetype-pdf.svg';
import infoCircleFill from 'bootstrap-icons/icons/info-circle-fill.svg';
import markdown from 'bootstrap-icons/icons/markdown.svg';
import printer from 'bootstrap-icons/icons/printer.svg';
import xLg from 'bootstrap-icons/icons/x-lg.svg';

/** A Bootstrap icon, pre-parsed at build time (scripts/build.mjs). */
export interface IconData {
  viewBox: string;
  children: [string, Record<string, string>][];
}

export const ICONS = {
  arrowRepeat,
  boxArrowUpRight,
  chatSquareText,
  checkCircleFill,
  clipboard,
  download,
  exclamationTriangleFill,
  fileEarmarkText,
  filetypeJson,
  filetypePdf,
  infoCircleFill,
  markdown,
  printer,
  xLg,
} satisfies Record<string, IconData>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Builds the icon with createElementNS: no markup parsing, so it works under Trusted Types too. */
export function icon(data: IconData, options: { size?: number; class?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const size = String(options.size ?? 16);
  svg.setAttribute('viewBox', data.viewBox);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', options.class ? `bi ${options.class}` : 'bi');
  for (const [tag, attrs] of data.children) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}
