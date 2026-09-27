import { describe, expect, it } from 'vitest';
import { convertPlainText, convertSelection, isSelectionFormat, isTableFormat } from '../src/core/convert';
import { defaultSettings } from '../src/core/settings';
import { el } from '../src/core/snapshot';

const settings = defaultSettings('en-US');

describe('convertSelection', () => {
  it('returns nothing for an empty selection', () => {
    expect(convertSelection({ kind: 'empty', url: '' }, 'markdown', settings)).toEqual({ text: '' });
  });

  it('keeps text-field selections as typed (no Markdown escaping), tidied', () => {
    const snapshot = { kind: 'plain' as const, text: '# Title\r\n\r\n\r\n*keep*  ​', truncated: false, url: '' };
    expect(convertSelection(snapshot, 'markdown', settings)).toEqual({ text: '# Title\n\n*keep*' });
  });

  it('uses the Markdown settings', () => {
    const snapshot = { kind: 'dom' as const, nodes: [el('ul', null, el('li', null, el('em', null, 'x')))], truncated: false, url: '' };
    expect(convertSelection(snapshot, 'markdown', { ...settings, bulletMarker: '+', emphasisMarker: '_' }).text).toBe('+ _x_');
  });
});

describe('convertPlainText', () => {
  it('builds escaped paragraphs for text/html', () => {
    expect(convertPlainText('a <b>\nnext\n\nsecond & last', 'html')).toEqual({
      text: 'a <b>\nnext\n\nsecond & last',
      html: '<p>a &lt;b&gt;<br>next</p>\n<p>second &amp; last</p>',
    });
  });

  it('adds no HTML for empty text', () => {
    expect(convertPlainText('  \n ', 'html')).toEqual({ text: '' });
  });
});

describe('format guards', () => {
  it('accept only known formats', () => {
    expect(isSelectionFormat('markdown')).toBe(true);
    expect(isSelectionFormat('csv')).toBe(false);
    expect(isTableFormat('tsv')).toBe(true);
    expect(isTableFormat('html')).toBe(false);
  });
});
