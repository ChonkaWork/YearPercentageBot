import type { ContentInfo } from '../core/types';

/** "Java error", "Python code", "JSON data", "table", "content"... */
export function subjectOf(content: ContentInfo): string {
  switch (content.kind) {
    case 'error':
      return content.language ? `${content.language} error` : 'error';
    case 'code':
      if (content.language === 'JSON') return 'JSON data';
      if (content.language === 'Shell') return 'shell commands';
      if (content.language === 'SQL') return 'SQL query';
      return content.language ? `${content.language} code` : 'code';
    case 'table':
      return 'table';
    case 'text':
      return 'content';
  }
}

export function developerOf(content: ContentInfo): string {
  return content.language ? `an experienced ${content.language} developer` : 'an experienced developer';
}

export function isJson(content: ContentInfo): boolean {
  return content.kind === 'code' && content.language === 'JSON';
}
