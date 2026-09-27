import { describe, expect, it } from 'vitest';
import {
  actionForCode,
  DEFAULT_KEYS,
  eventCode,
  findConflict,
  isBindableCode,
  isTypingTarget,
  keyLabel,
  matchShortcut,
  sanitizeBindings,
  type KeyEventLike,
} from '../src/core/keys';

function key(code: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: code.replace(/^Key/, '').toLowerCase(),
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
    ...extra,
  };
}

const bindings = sanitizeBindings(undefined);
const body = { tagName: 'BODY', isContentEditable: false, role: null };

describe('bindings', () => {
  it('defaults to S D R G Z X V', () => {
    expect(bindings).toEqual(DEFAULT_KEYS);
    expect(Object.values(bindings).map(keyLabel).join('')).toBe('SDRGZXV');
  });

  it('keeps valid keys, restores invalid ones, keeps explicit "no key"', () => {
    const result = sanitizeBindings({ faster: 'KeyF', slower: 'Shift', reset: 42, preferred: null, rewind: 'Escape' });
    expect(result.faster).toBe('KeyF');
    expect(result.slower).toBe('KeyS');
    expect(result.reset).toBe('KeyR');
    expect(result.preferred).toBeNull();
    expect(result.rewind).toBe('KeyZ');
  });

  it('resolves duplicates: the first action keeps the key', () => {
    const result = sanitizeBindings({ slower: 'KeyD' });
    expect(result.slower).toBe('KeyD');
    expect(result.faster).toBeNull();
  });

  it('rejects modifiers, Tab, Escape and junk', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'MetaLeft', 'AltRight', 'Tab', 'Escape', 'CapsLock', '', '1abc', 'Key S', 'a'.repeat(40)]) {
      expect(isBindableCode(code), code).toBe(false);
    }
    for (const code of ['KeyA', 'Digit1', 'Comma', 'BracketLeft', 'Space', 'F5', 'Numpad4', 'ArrowLeft']) {
      expect(isBindableCode(code), code).toBe(true);
    }
  });

  it('finds conflicts and actions', () => {
    expect(findConflict(bindings, 'slower', 'KeyD')).toBe('faster');
    expect(findConflict(bindings, 'faster', 'KeyD')).toBeNull();
    expect(findConflict(bindings, 'faster', 'KeyF')).toBeNull();
    expect(actionForCode(bindings, 'KeyG')).toBe('preferred');
    expect(actionForCode(bindings, 'KeyQ')).toBeNull();
    expect(actionForCode(bindings, '')).toBeNull();
  });

  it('labels keys like a US keyboard prints them', () => {
    expect(keyLabel('KeyS')).toBe('S');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Numpad7')).toBe('Num 7');
    expect(keyLabel('Comma')).toBe(',');
    expect(keyLabel('BracketRight')).toBe(']');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('F12')).toBe('F12');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('IntlRo')).toBe('IntlRo');
    expect(keyLabel(null)).toBe('Not set');
  });
});

describe('matching key presses', () => {
  it('matches plain shortcut keys by physical key', () => {
    expect(matchShortcut(bindings, key('KeyD'), body)).toEqual({ action: 'faster', repeatOnly: false });
    // Ukrainian layout: the S key types "і" but its code is KeyS.
    expect(matchShortcut(bindings, key('KeyS', { key: 'і' }), body)?.action).toBe('slower');
    expect(matchShortcut(bindings, key('KeyQ'), body)).toBeNull();
  });

  it('ignores presses with a modifier held', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      expect(matchShortcut(bindings, key('KeyD', { [modifier]: true }), body), modifier).toBeNull();
    }
  });

  it('ignores IME composition', () => {
    expect(matchShortcut(bindings, key('KeyD', { isComposing: true }), body)).toBeNull();
    expect(matchShortcut(bindings, key('KeyD', { keyCode: 229, key: 'Process' }), body)).toBeNull();
  });

  it('ignores typing in fields and editors', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(matchShortcut(bindings, key('KeyD'), { tagName, isContentEditable: false, role: null }), tagName).toBeNull();
    }
    expect(matchShortcut(bindings, key('KeyD'), { tagName: 'DIV', isContentEditable: true, role: null })).toBeNull();
    expect(matchShortcut(bindings, key('KeyD'), { tagName: 'DIV', isContentEditable: false, role: 'textbox' })).toBeNull();
    expect(matchShortcut(bindings, key('KeyD'), { tagName: 'DIV', isContentEditable: false, role: ' SearchBox ' })).toBeNull();
    expect(matchShortcut(bindings, key('KeyD'), { tagName: 'DIV', isContentEditable: false, role: 'button' })?.action).toBe('faster');
    expect(matchShortcut(bindings, key('KeyD'), null)?.action).toBe('faster');
    expect(isTypingTarget({ tagName: 'VIDEO', isContentEditable: false, role: null })).toBe(false);
  });

  it('repeats speed and seek keys, not toggles', () => {
    expect(matchShortcut(bindings, key('KeyD', { repeat: true }), body)).toEqual({ action: 'faster', repeatOnly: false });
    expect(matchShortcut(bindings, key('KeyZ', { repeat: true }), body)).toEqual({ action: 'rewind', repeatOnly: false });
    expect(matchShortcut(bindings, key('KeyG', { repeat: true }), body)).toEqual({ action: 'preferred', repeatOnly: true });
    expect(matchShortcut(bindings, key('KeyV', { repeat: true }), body)).toEqual({ action: 'toggleController', repeatOnly: true });
  });

  it('falls back to the character when a keyboard reports no code', () => {
    expect(eventCode({ code: '', key: 'd' })).toBe('KeyD');
    expect(eventCode({ code: '', key: 'D' })).toBe('KeyD');
    expect(eventCode({ code: '', key: '5' })).toBe('Digit5');
    expect(eventCode({ code: '', key: 'і' })).toBe('');
    expect(matchShortcut(bindings, key('', { key: 'r' }), body)?.action).toBe('reset');
  });

  it('respects rebinding and unbinding', () => {
    const custom = sanitizeBindings({ faster: 'KeyF', slower: null });
    expect(matchShortcut(custom, key('KeyF'), body)?.action).toBe('faster');
    expect(matchShortcut(custom, key('KeyD'), body)).toBeNull();
    expect(matchShortcut(custom, key('KeyS'), body)).toBeNull();
  });
});
