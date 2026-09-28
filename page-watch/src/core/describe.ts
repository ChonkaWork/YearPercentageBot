import { extractNumbers } from './numbers';
import { splitLines } from './normalize';

/**
 * What the picker says about the part the user picked, in plain words: "Price: $129.00",
 * "Text: In stock", "Section: 5 lines". The selector itself is a detail.
 */
export interface PickedSummary {
  label: 'Price' | 'Number' | 'Text' | 'Section';
  value: string;
  /** The full text, when it says more than `value` (shown as a preview). */
  detail: string | null;
}

const SHORT_TEXT_CHARS = 80;

export function describePicked(text: string): PickedSummary {
  const lines = splitLines(text);
  if (lines.length <= 1 && text.length <= SHORT_TEXT_CHARS) {
    const tokens = extractNumbers(text).filter((token) => !token.raw.endsWith('%'));
    const price = tokens.find((token) => token.isPrice);
    if (price) return { label: 'Price', value: price.raw, detail: text === price.raw ? null : text };
    const number = tokens[0];
    // "12" or "12 left" read as a number; a sentence with a number in it is text.
    if (number && text.length <= number.raw.length + 12) return { label: 'Number', value: number.raw, detail: text === number.raw ? null : text };
    return { label: 'Text', value: text, detail: null };
  }
  const chars = text.length;
  return {
    label: 'Section',
    value: `${lines.length} line${lines.length === 1 ? '' : 's'} · ${chars.toLocaleString('en')} character${chars === 1 ? '' : 's'}`,
    detail: text,
  };
}
