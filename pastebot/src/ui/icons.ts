import arrowReturnLeft from 'bootstrap-icons/icons/arrow-return-left.svg';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg';
import clipboard from 'bootstrap-icons/icons/clipboard.svg';
import clipboardCheck from 'bootstrap-icons/icons/clipboard-check.svg';
import clockHistory from 'bootstrap-icons/icons/clock-history.svg';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import gear from 'bootstrap-icons/icons/gear.svg';
import keyboard from 'bootstrap-icons/icons/keyboard.svg';
import link45deg from 'bootstrap-icons/icons/link-45deg.svg';
import shieldLock from 'bootstrap-icons/icons/shield-lock.svg';
import trash3 from 'bootstrap-icons/icons/trash3.svg';
import xLg from 'bootstrap-icons/icons/x-lg.svg';

/** Bootstrap Icons, bundled as SVG text at build time. */
const SVGS = {
  arrowReturnLeft,
  checkCircleFill,
  clipboard,
  clipboardCheck,
  clockHistory,
  exclamationTriangleFill,
  gear,
  keyboard,
  link45deg,
  shieldLock,
  trash3,
  xLg,
} as const;

export type IconName = keyof typeof SVGS;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPE = /<(path|circle|rect|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;

/**
 * Builds an icon with createElementNS instead of innerHTML, so it also works on pages that
 * enforce Trusted Types. The markup is static package content, never page data.
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
