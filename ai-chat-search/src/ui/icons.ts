import arrowCounterclockwise from 'bootstrap-icons/icons/arrow-counterclockwise.svg';
import arrowRight from 'bootstrap-icons/icons/arrow-right.svg';
import bookmarkCheck from 'bootstrap-icons/icons/bookmark-check.svg';
import bookmarkPlus from 'bootstrap-icons/icons/bookmark-plus.svg';
import boxArrowUpRight from 'bootstrap-icons/icons/box-arrow-up-right.svg';
import chatSquareText from 'bootstrap-icons/icons/chat-square-text.svg';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg';
import database from 'bootstrap-icons/icons/database.svg';
import download from 'bootstrap-icons/icons/download.svg';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import gem from 'bootstrap-icons/icons/gem.svg';
import infoCircleFill from 'bootstrap-icons/icons/info-circle-fill.svg';
import plusLg from 'bootstrap-icons/icons/plus-lg.svg';
import search from 'bootstrap-icons/icons/search.svg';
import shieldLock from 'bootstrap-icons/icons/shield-lock.svg';
import star from 'bootstrap-icons/icons/star.svg';
import starFill from 'bootstrap-icons/icons/star-fill.svg';
import tag from 'bootstrap-icons/icons/tag.svg';
import trash3 from 'bootstrap-icons/icons/trash3.svg';
import x from 'bootstrap-icons/icons/x.svg';
import xLg from 'bootstrap-icons/icons/x-lg.svg';

/** A Bootstrap icon, pre-parsed at build time (scripts/build.mjs). */
export interface IconData {
  viewBox: string;
  children: [string, Record<string, string>][];
}

export const ICONS = {
  arrowCounterclockwise,
  arrowRight,
  bookmarkCheck,
  bookmarkPlus,
  boxArrowUpRight,
  chatSquareText,
  checkCircleFill,
  database,
  download,
  exclamationTriangleFill,
  gem,
  infoCircleFill,
  plusLg,
  search,
  shieldLock,
  star,
  starFill,
  tag,
  trash3,
  x,
  xLg,
} satisfies Record<string, IconData>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Builds the icon with createElementNS: no markup parsing. */
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
