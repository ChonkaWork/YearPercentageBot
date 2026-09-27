import type { PromptTemplate } from './types';

export const customTemplate: PromptTemplate = {
  id: 'custom',
  label: 'Custom',
  description: 'Your own instruction',
  // The user's instruction decides the language (e.g. "Translate to English").
  matchContentLanguage: false,
  build({ customInstruction }) {
    return {
      task: customInstruction,
      conciseOutput: ['Keep it concise.'],
      detailedOutput: ['Be thorough.'],
    };
  },
};
