import { isJson, subjectOf } from './shared';
import type { PromptTemplate } from './types';

export const rewriteTemplate: PromptTemplate = {
  id: 'rewrite',
  label: 'Rewrite',
  description: 'Clearer wording, same meaning and facts',
  // "Keep the original language" is part of the instruction itself.
  matchContentLanguage: false,
  build({ content }) {
    if (isJson(content)) {
      return {
        task: 'Reformat the following JSON data so it is clean and consistently indented.',
        guidance: ['Keep all keys and values exactly as they are.'],
        output: ['Return only the JSON.'],
        detailedOutput: ['Return only the JSON.'],
      };
    }
    switch (content.kind) {
      case 'code':
        return {
          task: `Refactor the following ${subjectOf(content)} to improve readability and structure without changing its behavior.`,
          guidance: ['Keep the public interface the same and do not add features.'],
          output: ['Return the refactored code, followed by a brief list of the changes.'],
          conciseOutput: ['Return only the refactored code.'],
          detailedOutput: ['Return the refactored code, followed by a list of the changes and the reasoning behind each.'],
        };
      case 'table':
        return {
          task: 'Rewrite the following table as a clean, well-formatted Markdown table.',
          guidance: ['Keep all values exactly as they are.'],
          output: ['Return only the table.'],
          detailedOutput: ['Return only the table.'],
        };
      case 'error':
      case 'text':
        return {
          task: 'Rewrite the following content while preserving its meaning.',
          guidance: [
            'Improve clarity, structure, grammar and readability. Keep the original language and tone.',
            'Do not add facts that are not in the original.',
          ],
          output: ['Return only the rewritten text.'],
          conciseOutput: ['Return only the rewritten text.'],
          detailedOutput: ['Return the rewritten text, followed by a short list of the main changes.'],
        };
    }
  },
};
