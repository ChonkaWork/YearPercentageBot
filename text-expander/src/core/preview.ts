/**
 * How a snippet looks in lists and previews, the same in the popup, the manager and the
 * in-page suggestions: literal text, variables as small chips, `{cursor}` as a caret mark.
 * Pure: the UI turns the parts into DOM nodes.
 */

import { expandTemplate, isChoice, parseChoiceSpec, parseFieldSpec, tokenize } from './variables';

export type PreviewPart =
  | { kind: 'text'; text: string }
  /** A value known now: a date, a time, a weekday. `token` is the variable as written. */
  | { kind: 'value'; text: string; token: string }
  /** Filled in at insert time: a fill-in field or choice (its name), or the clipboard. */
  | { kind: 'field'; text: string; token: string }
  /** Where the caret goes. */
  | { kind: 'caret' };

export interface PreviewOptions {
  now: Date;
  locale?: string | undefined;
  /** False on the free plan: fill-in fields and choices are inserted as written, so they show as text. */
  fields: boolean;
  /** One line for lists: line breaks become ` ⏎ `, runs of spaces collapse, and the result is cut at `max` characters. */
  oneLine?: boolean;
  max?: number;
}

/** The marker lists show for a line break. */
export const LINE_BREAK = ' ⏎ ';

export function previewParts(template: string, options: PreviewOptions): PreviewPart[] {
  const parts: PreviewPart[] = [];
  let cursorPlaced = false;
  const text = (value: string) => {
    if (!value) return;
    const previous = parts[parts.length - 1];
    if (previous?.kind === 'text') previous.text += value;
    else parts.push({ kind: 'text', text: value });
  };

  // A one-line preview shows the start only; don't tokenize 50,000 characters for it.
  const source = options.oneLine ? template.slice(0, (options.max ?? 160) * 8) : template;
  for (const token of tokenize(source.replaceAll('\u0000', ''))) {
    if (token.kind === 'text') {
      text(token.text);
      continue;
    }
    const { name, arg, raw } = token;
    if (name === 'cursor') {
      if (arg !== undefined) text(raw);
      else if (!cursorPlaced) {
        cursorPlaced = true;
        parts.push({ kind: 'caret' });
      }
    } else if (name === 'clipboard') {
      if (arg === undefined) parts.push({ kind: 'field', text: 'clipboard', token: raw });
      else text(raw);
    } else if (name === 'input' || name === 'choice') {
      const field = arg === undefined ? null : name === 'choice' ? parseChoiceSpec(arg) : parseFieldSpec(arg);
      if (field && options.fields) parts.push({ kind: 'field', text: isChoice(field) ? `${field.name} ▾` : field.name, token: raw });
      else text(raw);
    } else if (name === 'weekday' && arg !== undefined) {
      text(raw);
    } else {
      parts.push({ kind: 'value', text: expandTemplate(raw, { now: options.now, locale: options.locale }).text, token: raw });
    }
  }
  return options.oneLine ? toOneLine(parts, options.max ?? 160) : collapseBlankLines(parts);
}

/** Lists show two lines at most: blank lines between paragraphs are dropped. */
function collapseBlankLines(parts: PreviewPart[]): PreviewPart[] {
  return parts.map((part) => (part.kind === 'text' ? { kind: 'text', text: part.text.replace(/\n[ \t]*\n+/g, '\n') } : part));
}

function toOneLine(parts: PreviewPart[], max: number): PreviewPart[] {
  const flat: PreviewPart[] = parts.map((part) => (part.kind === 'text' ? { ...part } : part));
  // Leading and trailing whitespace (line breaks included) isn't worth a ⏎.
  const first = flat[0];
  if (first?.kind === 'text') first.text = first.text.trimStart();
  const last = flat[flat.length - 1];
  if (last?.kind === 'text') last.text = last.text.trimEnd();
  for (const part of flat) {
    if (part.kind === 'text') part.text = part.text.replace(/[ \t]*\n\s*/g, LINE_BREAK).replace(/[ \t]+/g, ' ');
  }

  const out: PreviewPart[] = [];
  let length = 0;
  for (const part of flat) {
    if (part.kind === 'text' && !part.text) continue;
    const size = part.kind === 'caret' ? 0 : part.text.length;
    if (length + size <= max) {
      out.push(part);
      length += size;
      continue;
    }
    // Cut inside text; a chip that doesn't fit is left out.
    const room = max - length - 1;
    if (part.kind === 'text' && room > 0) out.push({ kind: 'text', text: `${part.text.slice(0, room).trimEnd()}…` });
    else out.push({ kind: 'text', text: '…' });
    break;
  }
  return out;
}

/** The preview as plain text (for titles and screen readers): chips as their text, the caret dropped. */
export function previewPlainText(parts: readonly PreviewPart[]): string {
  return parts.map((part) => (part.kind === 'caret' ? '' : part.text)).join('');
}
