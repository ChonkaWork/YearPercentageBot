import { findTemplate } from '../core/customTemplates';
import { generatePrompt } from '../core/generate';
import { resolveTargetLanguage } from '../core/languages';
import { hasFeature, limitMessage } from '../core/plan';
import { sanitizePageContext } from '../core/pageContext';
import { maskOptionsOf } from '../core/settings';
import type { PageContext, PromptAction } from '../core/types';
import { isoDate, sanitizeValues, type VariableValues } from '../core/variables';
import type { MakePromptResponse } from '../platform/messages';
import { addHistoryItem, loadPlanState, loadSettings, loadTemplates, saveLastInstruction } from '../storage/store';
import { copyToClipboard } from './clipboard';

export interface MakePromptInput {
  action: PromptAction;
  text: string;
  customInstruction?: string;
  includePageContext: boolean;
  page: PageContext | null;
  copy: boolean;
  /** Custom template (Pro): its stored instruction replaces `customInstruction`. */
  templateId?: string;
  /** Answers to the template's {{variables}}. */
  variables?: Record<string, string>;
  /** Make it without masking ("Undo masking for this prompt"). Never saved to history. */
  unmasked?: boolean;
}

/** The single path every prompt goes through: generate (masked), copy, remember. */
export async function makePrompt(input: MakePromptInput): Promise<MakePromptResponse> {
  const [settings, planState] = await Promise.all([loadSettings(), loadPlanState()]);
  const page = sanitizePageContext(input.page);

  let action = input.action;
  let instruction = input.customInstruction ?? '';
  let templateName: string | undefined;
  let variables: VariableValues | null = null;
  if (input.templateId !== undefined) {
    if (!hasFeature(planState.plan, 'templates', planState.earlyAccess)) {
      return { ok: false, code: 'PRO_REQUIRED', message: limitMessage('templates') };
    }
    const template = findTemplate(await loadTemplates(), input.templateId);
    if (!template) return { ok: false, code: 'TEMPLATE_NOT_FOUND', message: 'This template no longer exists. It may have been deleted in settings.' };
    // Same generator as the Custom action: cleanup, detection, style and page context apply.
    action = 'custom';
    instruction = template.instruction;
    templateName = template.name;
    if (hasFeature(planState.plan, 'template-variables', planState.earlyAccess)) {
      variables = { page, date: isoDate(), values: sanitizeValues(input.variables) };
    }
  }

  const mask = input.unmasked ? null : maskOptionsOf(settings);
  const result = generatePrompt({
    action,
    selectedText: input.text,
    style: settings.promptStyle,
    pageContext: input.includePageContext ? page : null,
    customInstruction: instruction,
    targetLanguage: resolveTargetLanguage(settings.translateTo, uiLanguage()).name,
    mask,
    variables,
  });
  if (!result.ok) return result;

  const copied = input.copy ? await copyToClipboard(result.prompt) : false;

  let historyId: string | null = null;
  let historySaved = true;
  // Undoing the masking copies the original once; history keeps the masked prompt it already has.
  if (!input.unmasked) {
    try {
      const item = await addHistoryItem(
        // The preview is taken from the masked content, so no original value is ever stored.
        { action, prompt: result.prompt, page, sourceText: result.source, ...(templateName ? { templateName } : {}) },
        settings.maxHistoryItems,
        planState.limits,
      );
      historyId = item?.id ?? null;
    } catch {
      historySaved = false;
    }
    if (action === 'custom' && templateName === undefined) await saveLastInstruction((input.customInstruction ?? '').trim());
  }

  return { ok: true, prompt: result.prompt, copied, historyId, historySaved, masked: result.masked, maskingOn: mask !== null };
}

function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}
