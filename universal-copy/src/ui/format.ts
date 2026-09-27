export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function tableSize(rows: number, columns: number): string {
  return `${formatCount(rows)} ${plural(rows, 'row')} × ${formatCount(columns)} ${plural(columns, 'column')}`;
}
