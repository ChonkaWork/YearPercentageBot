export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function tableSize(rows: number, columns: number): string {
  return `${formatCount(rows)} ${plural(rows, 'row')} × ${formatCount(columns)} ${plural(columns, 'column')}`;
}

export type AddFailure = 'not-allowed' | 'empty' | 'full' | 'too-big' | 'duplicate';

/** Why a table couldn't go into the basket, and what to do about it. */
export function basketFailure(reason: AddFailure, maxTables: number): { title: string; detail: string } {
  switch (reason) {
    case 'not-allowed':
      return { title: 'Merging tables is a Pro feature', detail: 'Open Table Copy settings to read about Pro.' };
    case 'empty':
      return { title: 'This table is empty', detail: 'It has no rows to add.' };
    case 'duplicate':
      return { title: 'Already in the basket', detail: 'This table was added before.' };
    case 'full':
      return { title: 'The basket is full', detail: `It holds up to ${maxTables} tables. Export or remove some first.` };
    case 'too-big':
      return { title: 'The basket is too big for this table', detail: 'Export or remove some tables first.' };
  }
}
