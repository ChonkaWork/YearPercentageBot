import { subjectOf } from './shared';
import type { PromptTemplate } from './types';

const COMPARISON_STEPS = [
  'The items being compared',
  'Key differences and similarities',
  'Advantages and disadvantages of each',
  'Trade-offs, and which option fits which situation',
];

export const compareTemplate: PromptTemplate = {
  id: 'compare',
  label: 'Compare',
  description: 'Differences, trade-offs, pros and cons',
  matchContentLanguage: true,
  build({ content }) {
    switch (content.kind) {
      case 'code':
        return {
          task: `Compare the approaches in the following ${subjectOf(content)}.`,
          conciseTask: `Compare the approaches in the following ${subjectOf(content)} and say which one to prefer.`,
          steps: [
            'Differences in behavior',
            'Readability and maintainability',
            'Performance and resource usage',
            'Which approach to prefer, and when',
          ],
          output: ['Present the comparison clearly, using a table where it helps.'],
        };
      case 'table':
        return {
          task: 'Compare the items in the following table.',
          conciseTask: 'Compare the items in the following table and state the key differences and trade-offs.',
          steps: COMPARISON_STEPS,
          guidance: ['Base the comparison on the values in the table.'],
          output: ['Present the comparison clearly, using a table where it helps.'],
        };
      case 'error':
      case 'text':
        return {
          task: 'Compare the items described in the following content.',
          conciseTask: 'Compare the items described in the following content and state the key differences and trade-offs.',
          steps: COMPARISON_STEPS,
          detailedSteps: ['Criteria that are missing from the content but matter for the decision'],
          output: ['Present the comparison clearly, using a table where it helps.'],
        };
    }
  },
};
