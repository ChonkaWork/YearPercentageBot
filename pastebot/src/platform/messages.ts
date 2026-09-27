import type { DirectAction, PageContext, PromptAction, PromptErrorCode } from '../core/types';
import { isPromptAction } from '../core/types';

/** Viewport rectangle of the selection, used to place the panel next to it. */
export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

// --- Content script / popup → background -----------------------------------------------

export interface MakePromptRequest {
  type: 'pastebot/make';
  action: PromptAction;
  text: string;
  customInstruction?: string;
  includePageContext: boolean;
  page: PageContext | null;
  /** Copy in the background (offscreen document). The popup copies by itself. */
  copy: boolean;
}

export type MakePromptResponse =
  | { ok: true; prompt: string; copied: boolean; historyId: string | null; historySaved: boolean }
  | { ok: false; code: PromptErrorCode | 'INTERNAL'; message: string; length?: number; limit?: number };

export interface CopyRequest {
  type: 'pastebot/copy';
  text: string;
}

export type BackgroundRequest = MakePromptRequest | CopyRequest;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'pastebot/copy') return typeof message.text === 'string';
  return (
    message.type === 'pastebot/make' &&
    isPromptAction(message.action) &&
    typeof message.text === 'string' &&
    typeof message.includePageContext === 'boolean' &&
    typeof message.copy === 'boolean'
  );
}

// --- Background → offscreen document ----------------------------------------------------

export interface OffscreenCopyRequest {
  target: 'offscreen';
  type: 'pastebot/offscreen-copy';
  text: string;
}

// --- Background → in-page overlay -------------------------------------------------------

export interface PanelMessage {
  type: 'pastebot/overlay';
  view: 'panel';
  text: string;
  /** Length of the selection before capture truncation. */
  totalLength: number;
  page: PageContext | null;
  anchor: AnchorRect | null;
  includePageContext: boolean;
  defaultAction: DirectAction;
  lastInstruction: string;
  /** Set when a context-menu action needs the panel (e.g. the selection is too long). */
  presetAction?: DirectAction;
}

export interface ToastMessage {
  type: 'pastebot/overlay';
  view: 'toast';
  tone: 'success' | 'error';
  message: string;
}

export interface ManualCopyMessage {
  type: 'pastebot/overlay';
  view: 'manual-copy';
  prompt: string;
}

export type OverlayMessage = PanelMessage | ToastMessage | ManualCopyMessage;

export function isOverlayMessage(value: unknown): value is OverlayMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'pastebot/overlay';
}
