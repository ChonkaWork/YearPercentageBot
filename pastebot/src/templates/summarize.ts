import { subjectOf } from './shared';
import type { PromptTemplate } from './types';

const GROUPED_BULLETS = ['Use bullet points grouped under short headings.'];

export const summarizeTemplate: PromptTemplate = {
  id: 'summarize',
  label: 'Summarize',
  description: 'Concise bullet points that keep facts and numbers',
  matchContentLanguage: true,
  build({ content }) {
    const subject = subjectOf(content);
    switch (content.kind) {
      case 'code':
        return {
          task: `Summarize what the following ${subject} does.`,
          guidance: ['Cover its purpose, inputs and outputs, main logic and side effects.'],
          output: ['Use concise bullet points.'],
          conciseOutput: ['Answer in 2-3 sentences.'],
          detailedOutput: GROUPED_BULLETS,
        };
      case 'error':
        return {
          task: `Summarize the following ${subject}.`,
          guidance: ['State what failed, where it failed and the key messages. Skip repetitive stack frames.'],
          output: ['Use concise bullet points.'],
          conciseOutput: ['Answer in 2-3 sentences.'],
          detailedOutput: GROUPED_BULLETS,
        };
      case 'table':
        return {
          task: 'Summarize the following table.',
          guidance: ['Describe what it contains, the key figures and notable patterns. Keep numbers exact.'],
          output: ['Use concise bullet points.'],
          conciseOutput: ['Use 3-5 short bullet points.'],
          detailedOutput: GROUPED_BULLETS,
        };
      case 'text':
        return {
          task: 'Summarize the following content.',
          guidance: [
            'Preserve important facts, numbers, names, dates, decisions and context. Remove unnecessary repetition.',
          ],
          output: ['Use concise, structured bullet points.'],
          conciseOutput: ['Use 3-5 short bullet points.'],
          detailedOutput: ['Start with a one-sentence overview, then group the details under short headings as bullet points.'],
        };
    }
  },
};
