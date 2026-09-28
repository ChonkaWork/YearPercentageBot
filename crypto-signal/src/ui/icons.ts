// Bootstrap Icons, imported as SVG text at build time and inlined (no icon font, no requests).
import arrowClockwise from 'bootstrap-icons/icons/arrow-clockwise.svg?raw';
import arrowDownRight from 'bootstrap-icons/icons/arrow-down-right.svg?raw';
import arrowUpRight from 'bootstrap-icons/icons/arrow-up-right.svg?raw';
import bell from 'bootstrap-icons/icons/bell.svg?raw';
import bellFill from 'bootstrap-icons/icons/bell-fill.svg?raw';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg?raw';
import chevronDown from 'bootstrap-icons/icons/chevron-down.svg?raw';
import chevronLeft from 'bootstrap-icons/icons/chevron-left.svg?raw';
import clock from 'bootstrap-icons/icons/clock.svg?raw';
import clockHistory from 'bootstrap-icons/icons/clock-history.svg?raw';
import cloudSlash from 'bootstrap-icons/icons/cloud-slash-fill.svg?raw';
import cursor from 'bootstrap-icons/icons/cursor-fill.svg?raw';
import dash from 'bootstrap-icons/icons/dash-lg.svg?raw';
import exclamationOctagon from 'bootstrap-icons/icons/exclamation-octagon-fill.svg?raw';
import exclamationTriangle from 'bootstrap-icons/icons/exclamation-triangle-fill.svg?raw';
import gear from 'bootstrap-icons/icons/gear.svg?raw';
import hourglass from 'bootstrap-icons/icons/hourglass-split.svg?raw';
import infoCircle from 'bootstrap-icons/icons/info-circle.svg?raw';
import lock from 'bootstrap-icons/icons/lock-fill.svg?raw';
import pause from 'bootstrap-icons/icons/pause-fill.svg?raw';
import play from 'bootstrap-icons/icons/play-fill.svg?raw';
import plus from 'bootstrap-icons/icons/plus-lg.svg?raw';
import search from 'bootstrap-icons/icons/search.svg?raw';
import shieldLock from 'bootstrap-icons/icons/shield-lock-fill.svg?raw';
import slashCircle from 'bootstrap-icons/icons/slash-circle.svg?raw';
import star from 'bootstrap-icons/icons/star.svg?raw';
import starFill from 'bootstrap-icons/icons/star-fill.svg?raw';
import trash from 'bootstrap-icons/icons/trash3.svg?raw';
import wifiOff from 'bootstrap-icons/icons/wifi-off.svg?raw';
import x from 'bootstrap-icons/icons/x-lg.svg?raw';

const ICONS = {
  arrowClockwise,
  arrowDownRight,
  arrowUpRight,
  bell,
  bellFill,
  checkCircleFill,
  chevronDown,
  chevronLeft,
  clock,
  clockHistory,
  cloudSlash,
  cursor,
  dash,
  exclamationOctagon,
  exclamationTriangle,
  gear,
  hourglass,
  infoCircle,
  lock,
  pause,
  play,
  plus,
  search,
  shieldLock,
  slashCircle,
  star,
  starFill,
  trash,
  wifiOff,
  x,
} as const;

export type IconName = keyof typeof ICONS;

const template = document.createElement('template');

/** An inline SVG icon (decorative: aria-hidden). The markup is the static Bootstrap Icons file. */
export function icon(name: IconName, options: { size?: number; class?: string } = {}): SVGSVGElement {
  template.innerHTML = ICONS[name].trim();
  const element = template.content.firstElementChild as SVGSVGElement;
  // Drop the file's indentation so icons add no stray whitespace to textContent.
  for (const node of [...element.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
  const size = String(options.size ?? 16);
  element.setAttribute('width', size);
  element.setAttribute('height', size);
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('focusable', 'false');
  element.setAttribute('class', `bi${options.class ? ` ${options.class}` : ''}`);
  return element;
}
