import { developerOf, subjectOf } from './shared';
import type { PromptTemplate } from './types';

export const explainTemplate: PromptTemplate = {
  id: 'explain',
  label: 'Explain',
  description: 'Clear explanation of terms and reasoning',
  matchContentLanguage: true,
  build({ content }) {
    const subject = subjectOf(content);
    switch (content.kind) {
      case 'error':
        return {
          task: `Explain the following ${subject}.`,
          conciseTask: `Explain what is most likely causing the following ${subject} and how to fix it.`,
          steps: [
            'What is most likely causing it',
            'Which part of the code is responsible',
            'How to fix it',
            'How to prevent the same issue',
          ],
          detailedSteps: ['Other possible causes worth ruling out'],
          guidance: [`Be precise and assume the reader is ${developerOf(content)}.`],
        };
      case 'code':
        return {
          task: `Explain the following ${subject}.`,
          conciseTask: `Briefly explain what the following ${subject} does and how it works.`,
          steps: [
            'What it does overall',
            'How it works, step by step',
            'Any non-obvious constructs, idioms or APIs it uses',
          ],
          detailedSteps: ['Edge cases and pitfalls in how it behaves'],
          guidance: ['Assume the reader is a developer who has not seen this code before.'],
        };
      case 'table':
        return {
          task: 'Explain the following table.',
          steps: ['What each column represents', 'How to read the values', 'What the data shows'],
          detailedSteps: ['Anything unusual or potentially misleading in the data'],
          guidance: ['Keep numbers exact and do not invent data.'],
        };
      case 'text':
        return {
          task: 'Explain the following content clearly.',
          guidance: [
            'Assume I understand the general subject but not this specific material.',
            'Explain important terminology and the reasoning behind the key points.',
          ],
          detailedOutput: ['Use examples or analogies where they help, and structure the answer with headings.'],
        };
    }
  },
};
