import activity from 'bootstrap-icons/icons/activity.svg?raw';
import arrowClockwise from 'bootstrap-icons/icons/arrow-clockwise.svg?raw';
import arrowLeft from 'bootstrap-icons/icons/arrow-left.svg?raw';
import bell from 'bootstrap-icons/icons/bell.svg?raw';
import bellFill from 'bootstrap-icons/icons/bell-fill.svg?raw';
import barChartLine from 'bootstrap-icons/icons/bar-chart-line.svg?raw';
import boxArrowUpRight from 'bootstrap-icons/icons/box-arrow-up-right.svg?raw';
import caretDownFill from 'bootstrap-icons/icons/caret-down-fill.svg?raw';
import caretUpFill from 'bootstrap-icons/icons/caret-up-fill.svg?raw';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg?raw';
import check2 from 'bootstrap-icons/icons/check2.svg?raw';
import clockHistory from 'bootstrap-icons/icons/clock-history.svg?raw';
import cloudSlash from 'bootstrap-icons/icons/cloud-slash.svg?raw';
import dash from 'bootstrap-icons/icons/dash.svg?raw';
import exclamationOctagon from 'bootstrap-icons/icons/exclamation-octagon.svg?raw';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg?raw';
import fileEarmarkX from 'bootstrap-icons/icons/file-earmark-x.svg?raw';
import graphUp from 'bootstrap-icons/icons/graph-up.svg?raw';
import hourglassSplit from 'bootstrap-icons/icons/hourglass-split.svg?raw';
import infoCircle from 'bootstrap-icons/icons/info-circle.svg?raw';
import layoutThreeColumns from 'bootstrap-icons/icons/layout-three-columns.svg?raw';
import lockFill from 'bootstrap-icons/icons/lock-fill.svg?raw';
import questionCircle from 'bootstrap-icons/icons/question-circle.svg?raw';
import search from 'bootstrap-icons/icons/search.svg?raw';
import slashCircle from 'bootstrap-icons/icons/slash-circle.svg?raw';
import star from 'bootstrap-icons/icons/star.svg?raw';
import starFill from 'bootstrap-icons/icons/star-fill.svg?raw';
import trash3 from 'bootstrap-icons/icons/trash3.svg?raw';
import wifiOff from 'bootstrap-icons/icons/wifi-off.svg?raw';
import xLg from 'bootstrap-icons/icons/x-lg.svg?raw';

/** Bootstrap Icons, bundled as SVG text at build time (Vite `?raw`). */
const SVGS = {
  activity,
  arrowClockwise,
  arrowLeft,
  barChartLine,
  bell,
  bellFill,
  boxArrowUpRight,
  caretDownFill,
  caretUpFill,
  check2,
  checkCircleFill,
  clockHistory,
  cloudSlash,
  dash,
  exclamationOctagon,
  exclamationTriangleFill,
  fileEarmarkX,
  graphUp,
  hourglassSplit,
  infoCircle,
  layoutThreeColumns,
  lockFill,
  questionCircle,
  search,
  slashCircle,
  star,
  starFill,
  trash3,
  wifiOff,
  xLg,
} as const;

export type IconName = keyof typeof SVGS;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPE = /<(path|circle|rect|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;

/**
 * Builds an icon with createElementNS instead of innerHTML. The markup is static package
 * content, never API data.
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

/** Replaces `<span data-icon="search"></span>` placeholders in static HTML. */
export function mountIcons(root: ParentNode = document): void {
  for (const placeholder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = placeholder.dataset.icon;
    if (name && name in SVGS) placeholder.replaceWith(icon(name as IconName, placeholder.className));
  }
}

/** The extension mark: a rising line on a brand-blue tile. Same drawing as the toolbar icon. */
export function logo(size = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { width: '128', height: '128', rx: '30', fill: '#2e5cff' }],
    ['path', { d: 'M26 92h76', stroke: '#ffffff', 'stroke-opacity': '.35', 'stroke-width': '6', 'stroke-linecap': 'round' }],
    ['path', { d: 'M28 80l24-22 18 12 30-34', fill: 'none', stroke: '#ffffff', 'stroke-width': '11', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ['circle', { cx: '100', cy: '36', r: '9', fill: '#20c77a', stroke: '#ffffff', 'stroke-width': '5' }],
  ];
  for (const [tag, attrs] of shapes) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}
