import { subjectOf } from './shared';
import type { PromptTemplate } from './types';

const KEEP_AS_IS = 'Keep names, numbers, dates, prices, URLs and code exactly as they are.';

export const translateTemplate: PromptTemplate = {
  id: 'translate',
  label: 'Translate',
  description: 'Into your language (set in settings), same meaning and format',
  // The target language decides the answer's language.
  matchContentLanguage: false,
  build({ content, targetLanguage }) {
    switch (content.kind) {
      case 'code':
        return {
          task: `Translate the comments and user-facing strings in the following ${subjectOf(content)} into ${targetLanguage}.`,
          guidance: ['Do not change identifiers, logic, formatting or anything else in the code.'],
          output: ['Return the full code with the translations in place.'],
          detailedOutput: ['Return the full code with the translations in place, then list any strings that were ambiguous.'],
        };
      case 'error':
        return {
          task: `Translate the following ${subjectOf(content)} message into ${targetLanguage}.`,
          guidance: ['Keep stack frames, file names, identifiers and code unchanged.'],
          output: ['Return the translated message, then explain in one or two sentences what it means.'],
          conciseOutput: ['Return only the translated message.'],
        };
      case 'table':
        return {
          task: `Translate the text in the following table into ${targetLanguage}.`,
          guidance: ['Keep the table structure, numbers and units unchanged.'],
          output: ['Return the translated table in Markdown.'],
          detailedOutput: ['Return the translated table in Markdown.'],
        };
      case 'text':
        return {
          task: `Translate the following content into ${targetLanguage}.`,
          guidance: ['Keep the meaning, tone and formatting (paragraphs, lists, line breaks).', KEEP_AS_IS],
          output: ['Return only the translation.'],
          conciseOutput: ['Return only the translation.'],
          detailedOutput: ['Return the translation, then a short list of terms that were hard to translate and how you handled them.'],
        };
    }
  },
};
