import arrowLeft from 'bootstrap-icons/icons/arrow-left.svg';
import arrowRepeat from 'bootstrap-icons/icons/arrow-repeat.svg';
import arrowRight from 'bootstrap-icons/icons/arrow-right.svg';
import boxArrowUp from 'bootstrap-icons/icons/box-arrow-up.svg';
import bullseye from 'bootstrap-icons/icons/bullseye.svg';
import check2 from 'bootstrap-icons/icons/check2.svg';
import chevronRight from 'bootstrap-icons/icons/chevron-right.svg';
import copy from 'bootstrap-icons/icons/copy.svg';
import dashLg from 'bootstrap-icons/icons/dash-lg.svg';
import download from 'bootstrap-icons/icons/download.svg';
import link45deg from 'bootstrap-icons/icons/link-45deg.svg';
import checkLg from 'bootstrap-icons/icons/check-lg.svg';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import calendarHeart from 'bootstrap-icons/icons/calendar-heart.svg';
import gear from 'bootstrap-icons/icons/gear.svg';
import infoCircle from 'bootstrap-icons/icons/info-circle.svg';
import lock from 'bootstrap-icons/icons/lock.svg';
import hourglassSplit from 'bootstrap-icons/icons/hourglass-split.svg';
import pencil from 'bootstrap-icons/icons/pencil.svg';
import plusLg from 'bootstrap-icons/icons/plus-lg.svg';
import shieldCheck from 'bootstrap-icons/icons/shield-check.svg';
import trash3 from 'bootstrap-icons/icons/trash3.svg';

/** Bootstrap Icons, bundled as SVG text at build time. */
const SVGS = {
  arrowLeft,
  arrowRepeat,
  arrowRight,
  boxArrowUp,
  bullseye,
  calendarHeart,
  check2,
  checkLg,
  chevronRight,
  copy,
  dashLg,
  download,
  exclamationTriangleFill,
  gear,
  hourglassSplit,
  infoCircle,
  link45deg,
  lock,
  pencil,
  plusLg,
  shieldCheck,
  trash3,
} as const;

export type IconName = keyof typeof SVGS;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPE = /<(path|circle|rect|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;

/**
 * Builds an icon with createElementNS instead of innerHTML. The markup is static package
 * content, never user data.
 */
export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className ? `bi ${className}` : 'bi');
  for (const [, tag, attributes] of SVGS[name].matchAll(SHAPE)) {
    const shape = document.createElementNS(SVG_NS, tag ?? 'path');
    for (const [, attribute, value] of (attributes ?? '').matchAll(ATTRIBUTE)) {
      if (attribute && value !== undefined) shape.setAttribute(attribute, value);
    }
    svg.append(shape);
  }
  return svg;
}

/** Replaces `<span data-icon="gear"></span>` placeholders in static HTML. */
export function mountIcons(root: ParentNode = document): void {
  for (const placeholder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = placeholder.dataset.icon;
    if (name && name in SVGS) placeholder.replaceWith(icon(name as IconName, placeholder.className));
  }
}
