import type { TargetCandidate } from '../core/target';

/**
 * Popup ↔ content script messages. There is no background worker: the popup talks to the
 * tab directly with chrome.tabs.sendMessage (no "tabs" permission needed for that).
 *
 * Discovery: the popup broadcasts `discover` to every frame of the tab. The top frame answers
 * it directly; other frames that have media report back with runtime.sendMessage (only one
 * frame can answer a broadcast), which tells the popup their frameId. The popup then picks
 * the frame to control with the same rule the page uses (core/target.ts) and sends commands
 * to that frame only.
 */

export interface MediaSummary extends TargetCandidate {
  kind: 'video' | 'audio';
  speed: number;
  paused: boolean;
}

export interface FrameStatus {
  top: boolean;
  /** Site (top-level page) hostname, '' for file:// and similar. */
  site: string;
  /** This frame's own hostname. */
  frameHost: string;
  /** Blocklist entry that turns the extension off here, or null. */
  blockedBy: string | null;
  /** Media elements this frame controls. */
  mediaCount: number;
  /** What a shortcut would control right now. */
  target: MediaSummary | null;
  /** Last problem the page ran into (storage unavailable, speed rejected, ...). */
  problem: string | null;
}

export type Command = { kind: 'set'; speed: number } | { kind: 'step'; direction: 1 | -1 };

export interface DiscoverRequest {
  type: 'vsp/discover';
  nonce: string;
}

export interface CommandRequest {
  type: 'vsp/command';
  command: Command;
}

export type ContentRequest = DiscoverRequest | CommandRequest;

export type CommandResponse = { ok: true; status: FrameStatus } | { ok: false; error: string };

export interface FrameReport {
  type: 'vsp/report';
  nonce: string;
  status: FrameStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCommand(value: unknown): value is Command {
  if (!isRecord(value)) return false;
  if (value.kind === 'set') return typeof value.speed === 'number' && Number.isFinite(value.speed);
  if (value.kind === 'step') return value.direction === 1 || value.direction === -1;
  return false;
}

export function isContentRequest(value: unknown): value is ContentRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'vsp/discover') return typeof value.nonce === 'string';
  if (value.type === 'vsp/command') return isCommand(value.command);
  return false;
}

export function isFrameStatus(value: unknown): value is FrameStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.top === 'boolean' &&
    typeof value.site === 'string' &&
    typeof value.frameHost === 'string' &&
    (value.blockedBy === null || typeof value.blockedBy === 'string') &&
    typeof value.mediaCount === 'number' &&
    (value.target === null || isRecord(value.target)) &&
    (value.problem === null || typeof value.problem === 'string')
  );
}

export function isFrameReport(value: unknown): value is FrameReport {
  return isRecord(value) && value.type === 'vsp/report' && typeof value.nonce === 'string' && isFrameStatus(value.status);
}

export function isCommandResponse(value: unknown): value is CommandResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isFrameStatus(value.status);
  return value.ok === false && typeof value.error === 'string';
}
