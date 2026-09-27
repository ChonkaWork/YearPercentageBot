import { developerOf, subjectOf } from './shared';
import type { PromptTemplate } from './types';

export const analyzeTemplate: PromptTemplate = {
  id: 'analyze',
  label: 'Analyze',
  description: 'Key points, assumptions, problems and conclusions',
  matchContentLanguage: true,
  build({ content }) {
    const subject = subjectOf(content);
    switch (content.kind) {
      case 'error':
        return {
          task: `Analyze the following ${subject}.`,
          conciseTask: `Analyze the following ${subject} and identify its most likely root cause.`,
          steps: [
            'The most likely root cause',
            'Where in the code it originates',
            'Other plausible causes',
            'What additional information would confirm the diagnosis',
          ],
          detailedSteps: ['How to fix it, with a short code example if relevant'],
          guidance: [`Be precise and assume the reader is ${developerOf(content)}.`],
        };
      case 'code':
        return {
          task: `Analyze the following ${subject}.`,
          conciseTask: `Review the following ${subject} and point out the most important problems.`,
          steps: [
            'What it does',
            'Bugs and unhandled edge cases',
            'Security and performance concerns',
            'Readability and maintainability issues',
          ],
          detailedSteps: ['Concrete improvements, with code where it helps'],
          guidance: ['Distinguish confirmed problems from potential ones and reference the specific lines.'],
        };
      case 'table':
        return {
          task: 'Analyze the following table.',
          conciseTask: 'Analyze the following table and state its key takeaways.',
          steps: [
            'What the data represents',
            'Key patterns, trends and outliers',
            'Notable differences between rows or columns',
            'Conclusions the data supports',
          ],
          detailedSteps: ['Limitations of the data and what is missing'],
          guidance: ['Base every statement on the values in the table and do not invent data.'],
        };
      case 'text':
        return {
          task: 'Analyze the following content.',
          conciseTask:
            'Analyze the following content: identify the key points, assumptions, potential problems and conclusions.',
          steps: [
            'The important information and main points',
            'Underlying assumptions',
            'Potential problems, risks or weak arguments',
            'The conclusions it supports',
          ],
          detailedSteps: ['Missing information and open questions'],
          guidance: ['Structure the response clearly and distinguish facts stated in the content from assumptions.'],
        };
    }
  },
};
