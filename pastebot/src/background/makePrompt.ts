import { generatePrompt } from '../core/generate';
import { sanitizePageContext } from '../core/pageContext';
import type { PageContext, PromptAction } from '../core/types';
import type { MakePromptResponse } from '../platform/messages';
import { addHistoryItem, loadSettings, saveLastInstruction } from '../storage/store';
import { copyToClipboard } from './clipboard';

export interface MakePromptInput {
  action: PromptAction;
  text: string;
  customInstruction?: string;
  includePageContext: boolean;
  page: PageContext | null;
  copy: boolean;
}

/** The single path every prompt goes through: generate, copy, remember. */
export async function makePrompt(input: MakePromptInput): Promise<MakePromptResponse> {
  const settings = await loadSettings();
  const page = sanitizePageContext(input.page);
  const result = generatePrompt({
    action: input.action,
    selectedText: input.text,
    style: settings.promptStyle,
    pageContext: input.includePageContext ? page : null,
    customInstruction: input.customInstruction ?? '',
  });
  if (!result.ok) return result;

  const copied = input.copy ? await copyToClipboard(result.prompt) : false;

  let historyId: string | null = null;
  let historySaved = true;
  try {
    const item = await addHistoryItem(
      { action: input.action, prompt: result.prompt, page, sourceText: input.text },
      settings.maxHistoryItems,
    );
    historyId = item?.id ?? null;
  } catch {
    historySaved = false;
  }
  if (input.action === 'custom') await saveLastInstruction((input.customInstruction ?? '').trim());

  return { ok: true, prompt: result.prompt, copied, historyId, historySaved };
}
