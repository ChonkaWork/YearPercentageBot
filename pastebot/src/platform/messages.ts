import { isDestination, type Destination } from '../core/destinations';
import type { MaskedItem, MaskOptions } from '../core/mask';
import type { DirectAction, PageContext, PromptAction, PromptErrorCode } from '../core/types';
import { isPromptAction } from '../core/types';
import type { AskVariable } from '../core/variables';

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
  /** A custom template (Pro). The background looks up its instruction; `action` must be `custom`. */
  templateId?: string;
  /** Answers to the template's {{variables}} (Pro). */
  variables?: Record<string, string>;
  /**
   * "Undo masking for this prompt": make it again without masking. The result is copied but
   * never saved to history (history keeps the masked prompt).
   */
  unmasked?: boolean;
}

export type MakePromptErrorCode = PromptErrorCode | 'INTERNAL' | 'TEMPLATE_NOT_FOUND' | 'PRO_REQUIRED';

export type MakePromptResponse =
  | {
      ok: true;
      prompt: string;
      copied: boolean;
      historyId: string | null;
      historySaved: boolean;
      /** What masking replaced; empty when off or nothing was found. Previews only, never values. */
      masked: MaskedItem[];
      /** Masking was on for this prompt (so "nothing found" can be told apart from "off"). */
      maskingOn: boolean;
    }
  | { ok: false; code: MakePromptErrorCode; message: string; length?: number; limit?: number };

/** What a panel, menu or popup needs to show a template. The instruction stays in storage. */
export interface TemplateRef {
  id: string;
  name: string;
  /** {{Variables}} to ask for before running it (empty when none, or without Pro). */
  asks: AskVariable[];
}

/** A built-in action or one of the user's templates. */
export type Choice = { action: DirectAction } | { template: TemplateRef };

export interface CopyRequest {
  type: 'pastebot/copy';
  text: string;
}

/** "Copy & open": copy (unless the sender already did) and open the chosen AI in a new tab. */
export interface OpenRequest {
  type: 'pastebot/open';
  destination: Destination;
  prompt: string;
  copy: boolean;
}

export interface OpenResponse {
  ok: boolean;
  copied: boolean;
  /** The prompt went into the address (ChatGPT, Perplexity) rather than needing a paste. */
  prefilled: boolean;
}

export type BackgroundRequest = MakePromptRequest | CopyRequest | OpenRequest;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'pastebot/copy') return typeof message.text === 'string';
  if (message.type === 'pastebot/open') {
    return isDestination(message.destination) && typeof message.prompt === 'string' && typeof message.copy === 'boolean';
  }
  return (
    message.type === 'pastebot/make' &&
    isPromptAction(message.action) &&
    typeof message.text === 'string' &&
    typeof message.includePageContext === 'boolean' &&
    typeof message.copy === 'boolean' &&
    (message.templateId === undefined || typeof message.templateId === 'string') &&
    (message.variables === undefined || (typeof message.variables === 'object' && message.variables !== null)) &&
    (message.unmasked === undefined || typeof message.unmasked === 'boolean')
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
  /** The user's templates when the plan includes them (empty otherwise). */
  templates: TemplateRef[];
  /** Set when a context-menu action needs the panel (e.g. the selection is too long). */
  preset?: Choice;
  /** Remembered "Copy & open" destination. */
  openIn: Destination;
  /** Masking settings, so the panel can say what will be masked before anything is made. */
  mask: MaskOptions | null;
  /** Language name the Translate action targets ("Ukrainian"). */
  translateTo: string;
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
