import { PROMPT_ACTIONS, type PromptAction } from '../core/types';
import { analyzeTemplate } from './analyze';
import { compareTemplate } from './compare';
import { customTemplate } from './custom';
import { explainTemplate } from './explain';
import { extractTemplate } from './extract';
import { rewriteTemplate } from './rewrite';
import { summarizeTemplate } from './summarize';
import { translateTemplate } from './translate';
import type { PromptTemplate } from './types';

export type { PromptSpec, PromptTemplate, TemplateContext } from './types';

/** Adding an action = adding its id to PROMPT_ACTIONS and a template here. */
const TEMPLATES: Record<PromptAction, PromptTemplate> = {
  analyze: analyzeTemplate,
  summarize: summarizeTemplate,
  explain: explainTemplate,
  extract: extractTemplate,
  compare: compareTemplate,
  rewrite: rewriteTemplate,
  translate: translateTemplate,
  custom: customTemplate,
};

export function getTemplate(action: PromptAction): PromptTemplate {
  return TEMPLATES[action];
}

export interface ActionInfo {
  id: PromptAction;
  label: string;
  description: string;
}

/** Actions in display order, for menus and pickers. */
export const ACTIONS: readonly ActionInfo[] = PROMPT_ACTIONS.map((id) => ({
  id,
  label: TEMPLATES[id].label,
  description: TEMPLATES[id].description,
}));

export function actionLabel(action: PromptAction): string {
  return TEMPLATES[action].label;
}
