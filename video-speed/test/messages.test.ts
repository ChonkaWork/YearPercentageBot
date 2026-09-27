import { describe, expect, it } from 'vitest';
import { isCommand, isCommandResponse, isContentRequest, isFrameReport, isFrameStatus, type FrameStatus } from '../src/platform/messages';

const status: FrameStatus = {
  top: true,
  site: 'example.com',
  frameHost: 'example.com',
  blockedBy: null,
  mediaCount: 1,
  target: { kind: 'video', speed: 1.5, paused: false, playing: true, interactedAt: 0, startedAt: 1, visibleArea: 100 },
  problem: null,
};

describe('message validation', () => {
  it('accepts well-formed requests only', () => {
    expect(isContentRequest({ type: 'vsp/discover', nonce: 'n' })).toBe(true);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'set', speed: 2 } })).toBe(true);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'step', direction: -1 } })).toBe(true);
    expect(isContentRequest({ type: 'vsp/discover' })).toBe(false);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'set', speed: '2' } })).toBe(false);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'set', speed: Number.NaN } })).toBe(false);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'step', direction: 5 } })).toBe(false);
    expect(isContentRequest({ type: 'vsp/command', command: { kind: 'eval' } })).toBe(false);
    expect(isContentRequest(null)).toBe(false);
    expect(isCommand({ kind: 'set', speed: 3 })).toBe(true);
  });

  it('accepts well-formed reports and responses only', () => {
    expect(isFrameStatus(status)).toBe(true);
    expect(isFrameStatus({ ...status, target: null, blockedBy: 'example.com' })).toBe(true);
    expect(isFrameStatus({ ...status, site: 3 })).toBe(false);
    expect(isFrameReport({ type: 'vsp/report', nonce: 'n', status })).toBe(true);
    expect(isFrameReport({ type: 'vsp/report', status })).toBe(false);
    expect(isCommandResponse({ ok: true, status })).toBe(true);
    expect(isCommandResponse({ ok: false, error: 'nope' })).toBe(true);
    expect(isCommandResponse({ ok: false })).toBe(false);
    expect(isCommandResponse(undefined)).toBe(false);
  });
});
