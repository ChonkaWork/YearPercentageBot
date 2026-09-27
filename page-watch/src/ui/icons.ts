// Bootstrap Icons used by the extension pages and the picker, imported as SVG text.
import arrowClockwise from 'bootstrap-icons/icons/arrow-clockwise.svg';
import arrowsAngleContract from 'bootstrap-icons/icons/arrows-angle-contract.svg';
import arrowsAngleExpand from 'bootstrap-icons/icons/arrows-angle-expand.svg';
import bell from 'bootstrap-icons/icons/bell.svg';
import boundingBox from 'bootstrap-icons/icons/bounding-box-circles.svg';
import boxArrowUpRight from 'bootstrap-icons/icons/box-arrow-up-right.svg';
import check2 from 'bootstrap-icons/icons/check2.svg';
import check2All from 'bootstrap-icons/icons/check2-all.svg';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg';
import chevronDown from 'bootstrap-icons/icons/chevron-down.svg';
import clockHistory from 'bootstrap-icons/icons/clock-history.svg';
import exclamationOctagonFill from 'bootstrap-icons/icons/exclamation-octagon-fill.svg';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import fileEarmarkText from 'bootstrap-icons/icons/file-earmark-text.svg';
import gear from 'bootstrap-icons/icons/gear.svg';
import hourglassSplit from 'bootstrap-icons/icons/hourglass-split.svg';
import infoCircle from 'bootstrap-icons/icons/info-circle.svg';
import key from 'bootstrap-icons/icons/key.svg';
import pauseCircle from 'bootstrap-icons/icons/pause-circle.svg';
import pauseFill from 'bootstrap-icons/icons/pause-fill.svg';
import pencil from 'bootstrap-icons/icons/pencil.svg';
import playFill from 'bootstrap-icons/icons/play-fill.svg';
import shieldLock from 'bootstrap-icons/icons/shield-lock.svg';
import trash3 from 'bootstrap-icons/icons/trash3.svg';
import xLg from 'bootstrap-icons/icons/x-lg.svg';

export const ICONS = {
  arrowClockwise,
  wider: arrowsAngleExpand,
  narrower: arrowsAngleContract,
  bell,
  pick: boundingBox,
  open: boxArrowUpRight,
  check: check2,
  checkAll: check2All,
  success: checkCircleFill,
  chevronDown,
  history: clockHistory,
  danger: exclamationOctagonFill,
  warning: exclamationTriangleFill,
  page: fileEarmarkText,
  gear,
  pending: hourglassSplit,
  info: infoCircle,
  key,
  paused: pauseCircle,
  pause: pauseFill,
  edit: pencil,
  play: playFill,
  privacy: shieldLock,
  trash: trash3,
  close: xLg,
} as const;
