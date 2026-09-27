import { isJson, subjectOf } from './shared';
import type { PromptTemplate } from './types';

export const extractTemplate: PromptTemplate = {
  id: 'extract',
  label: 'Extract',
  description: 'Structured data, no invented values',
  matchContentLanguage: true,
  build({ content }) {
    const subject = subjectOf(content);
    if (isJson(content)) {
      return {
        task: 'Extract the important fields from the following JSON data.',
        guidance: ['Keep every value exactly as written.'],
        output: ['Return a Markdown table with the field path, type and value.'],
      };
    }
    switch (content.kind) {
      case 'error':
        return {
          task: `Extract the key facts from the following ${subject}.`,
          steps: [
            'Error type and message',
            'File names and line numbers',
            'The call chain, from the entry point to the failure',
          ],
          guidance: ['Do not guess values that are not in the output.'],
          output: ['Return the result as a structured list.'],
        };
      case 'code':
        return {
          task: `Extract the structure of the following ${subject}.`,
          steps: [
            'Classes, functions and their signatures',
            'External dependencies and imports',
            'Configuration values, constants and hard-coded strings',
          ],
          guidance: ['Only list what is actually in the code.'],
          output: ['Return the result as a structured list.'],
        };
      case 'table':
        return {
          task: 'Extract the data from the following table.',
          guidance: ['Keep every value exactly as written. Do not invent missing values, leave those cells empty.'],
          output: ['Return it as a clean Markdown table with consistent columns.'],
          detailedOutput: ['Return it as a clean Markdown table with consistent columns, then as a JSON array of objects.'],
        };
      case 'text':
        return {
          task: 'Extract the important structured information from the following content.',
          guidance: [
            'Include names, organizations, dates, numbers, prices, URLs and action items where present.',
            'Do not invent missing information. If a detail is not stated, write "not specified".',
          ],
          output: ['Return the result in a clean, predictable format: a Markdown table or a list of labeled fields.'],
          conciseOutput: ['Return a compact list of labeled fields.'],
          detailedOutput: ['Return labeled fields grouped by topic, then list any ambiguities separately.'],
        };
    }
  },
};
