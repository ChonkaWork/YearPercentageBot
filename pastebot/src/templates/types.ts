import type { ContentInfo, PromptAction, PromptStyle } from '../core/types';

export interface TemplateContext {
  content: ContentInfo;
  style: PromptStyle;
  /** Trimmed user instruction (custom action only). */
  customInstruction: string;
}

/**
 * Declarative description of a prompt. Templates describe *what* to ask; the generator
 * decides layout and applies the prompt style (concise / balanced / detailed).
 */
export interface PromptSpec {
  /** Opening instruction, a full sentence. */
  task: string;
  /** One-sentence replacement for `task` in the concise style. */
  conciseTask?: string;
  /** Numbered points the answer should cover. Omitted in the concise style. */
  steps?: string[];
  /** Extra points appended in the detailed style. */
  detailedSteps?: string[];
  /** Line introducing the numbered points. Defaults to "Cover:". */
  stepsIntro?: string;
  /** Short guidance sentences shown after the steps (all styles). */
  guidance?: string[];
  /** Output requirements, placed after the content. */
  output?: string[];
  /** Replaces the generic "keep it short" line in the concise style. */
  conciseOutput?: string[];
  /** Replaces the generic "be thorough" line in the detailed style. */
  detailedOutput?: string[];
}

export interface PromptTemplate {
  id: PromptAction;
  label: string;
  /** Short hint for tooltips. */
  description: string;
  /** Whether to ask the AI to answer in the content's language when it isn't Latin-script. */
  matchContentLanguage: boolean;
  build(context: TemplateContext): PromptSpec;
}
