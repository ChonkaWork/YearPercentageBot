import arrowCounterclockwise from 'bootstrap-icons/icons/arrow-counterclockwise.svg?raw';
import circleFill from 'bootstrap-icons/icons/circle-fill.svg?raw';
import dashLg from 'bootstrap-icons/icons/dash-lg.svg?raw';
import { describe, expect, it } from 'vitest';
import { parseIcon } from '../src/ui/iconData';

describe('parseIcon', () => {
  it('reads real Bootstrap Icons files', () => {
    const dash = parseIcon(dashLg);
    expect(dash.viewBox).toBe('0 0 16 16');
    expect(dash.nodes).toHaveLength(1);
    expect(dash.nodes[0]?.tag).toBe('path');
    expect(dash.nodes[0]?.attrs['fill-rule']).toBe('evenodd');
    expect(dash.nodes[0]?.attrs.d).toMatch(/^M2 8a/);
    expect(parseIcon(arrowCounterclockwise).nodes).toHaveLength(2);
    expect(parseIcon(circleFill).nodes).toEqual([{ tag: 'circle', attrs: { cx: '8', cy: '8', r: '8' } }]);
  });

  it('keeps only shapes and geometry attributes', () => {
    const icon = parseIcon(
      '<svg viewBox="0 0 16 16" onload="alert(1)"><script>alert(1)</script><path d="M0 0h1" onclick="x()" style="fill:red"/><foreignObject/><a href="javascript:x"/></svg>',
    );
    expect(icon.nodes).toEqual([{ tag: 'path', attrs: { d: 'M0 0h1' } }]);
  });
});
