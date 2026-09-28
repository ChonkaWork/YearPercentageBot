import { replacementEdit, type Edit, type StepResult } from './changes';

/**
 * Typography cleanup (optional): the characters word processors and AI tools produce that
 * look odd, break search or give a text away once pasted into plain-text places.
 *
 *   “ ” „ ‟ → "      ‘ ’ ‚ ‛ → '      … → ...
 *   thin, hair, en/em and other fixed-width spaces → a normal space
 *   – (en dash) → -  and  — (em dash) → " - "   (unless dashes are kept)
 *
 * Pure: no DOM, no Chrome APIs.
 */

export type DashMode = 'keep' | 'hyphen';

const SPACE_CLASS = '[\\u2000-\\u200A\\u202F\\u205F]';
const AROUND = `[ \\t\\u2000-\\u200A\\u202F\\u205F]*`;
const BASE = `[\\u201C\\u201D\\u201E\\u201F]|[\\u2018\\u2019\\u201A\\u201B]|\\u2026|${SPACE_CLASS}`;
// Em dash (with the spaces around it, which it replaces) and en/figure dashes come first.
const WITH_DASHES = new RegExp(`${AROUND}[\\u2014\\u2015]${AROUND}|[\\u2012\\u2013]|${BASE}`, 'g');
const WITHOUT_DASHES = new RegExp(BASE, 'g');

export function typographyStep(text: string, dashes: DashMode = 'hyphen'): StepResult & { count: number } {
  const edits: Edit[] = [];
  let count = 0;
  const pattern = dashes === 'hyphen' ? WITH_DASHES : WITHOUT_DASHES;
  pattern.lastIndex = 0;
  const out = text.replace(pattern, (match: string, offset: number) => {
    const replacement = replace(match, text, offset);
    const edit = replacementEdit(offset, match, replacement, 'typography');
    if (edit) {
      edits.push(edit);
      count++;
    }
    return replacement;
  });
  return { text: out, edits, count };
}

function replace(match: string, text: string, offset: number): string {
  if (/[—―]/.test(match)) {
    const lineStart = offset === 0 || text[offset - 1] === '\n';
    const end = offset + match.length;
    const lineEnd = end === text.length || text[end] === '\n';
    return `${lineStart ? '' : ' '}-${lineEnd ? '' : ' '}`;
  }
  if (/[‒–]/.test(match)) return '-';
  if (/[“”„‟]/.test(match)) return '"';
  if (/[‘’‚‛]/.test(match)) return "'";
  if (match === '…') return '...';
  return ' ';
}
