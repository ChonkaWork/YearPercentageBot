import { detectContent } from './detect';
import { isUiNoise } from './noise';
import type { ContentInfo } from './types';

/**
 * Conservative cleanup of selected text. The goal is to remove obvious noise (invisible
 * characters, runs of blank lines, duplicated lines, stray UI labels) without ever
 * rewriting the user's content: URLs, numbers, prices, names, code and table cells must
 * survive unchanged.
 *
 * Input is always plain text (Selection.toString() or a textarea), never HTML.
 */

export interface PreparedContent {
  text: string;
  info: ContentInfo;
}

// Zero-width space, word joiner, BOM, soft hyphen. ZWJ/ZWNJ are kept on purpose:
// they are part of emoji sequences and required by some scripts.
const INVISIBLE_CHARS = /[​⁠﻿­]/g;
const NON_BREAKING_SPACES = /[   ]/g;

/** Lines shorter than this are never treated as duplicates ("Yes", "OK", "}" repeat legitimately). */
const MIN_DUPLICATE_LINE_LENGTH = 16;

export function prepareContent(raw: string): PreparedContent {
  const basic = normalizeBasics(raw);
  const info = detectContent(basic);
  const text = info.kind === 'code' || info.kind === 'error' ? cleanCode(basic) : cleanProse(basic);
  return { text, info };
}

/** Line endings, invisible characters, trailing whitespace, surrounding blank lines. */
export function normalizeBasics(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_CHARS, '')
    .replace(NON_BREAKING_SPACES, ' ')
    .split('\n')
    // Trailing tabs are kept: in tab-separated tables they are empty cells.
    .map((line) => (/^\s*$/.test(line) ? '' : line.replace(/[ \f\v]+$/, '')));
  return trimBlankLines(lines).join('\n');
}

/**
 * Code and stack traces: keep every character that matters, only tidy layout. UI labels
 * are removed only where they can't be code: at the edges of the selection (a "Share"
 * button under a snippet) or when they are multi-word phrases ("Improve this question").
 */
export function cleanCode(text: string): string {
  const dedented = dedent(trimBlankLines(removeUiNoiseAroundCode(text.split('\n'))));
  // Up to two blank lines are meaningful in some styles (PEP 8); more is noise.
  return dedented.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

export function cleanProse(text: string): string {
  let lines = text.split('\n');
  lines = removeUiNoise(lines);
  lines = removeRepeatedLines(lines);
  lines = collapseStraySpaces(lines);
  return trimBlankLines(lines).join('\n').replace(/\n{3,}/g, '\n\n');
}

function removeUiNoise(lines: string[]): string[] {
  const nonEmpty = lines.filter((line) => line.trim() !== '').length;
  // A short selection like "Share" is intentional content, not noise.
  if (nonEmpty < 3) return lines;
  const kept = lines.filter((line) => !isUiNoise(line));
  return kept.some((line) => line.trim() !== '') ? kept : lines;
}

function removeUiNoiseAroundCode(lines: string[]): string[] {
  const nonEmpty = lines.filter((line) => line.trim() !== '').length;
  if (nonEmpty < 3) return lines;
  const isBlankOrNoise = (line: string) => line.trim() === '' || isUiNoise(line);
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankOrNoise(lines[start] ?? '')) start++;
  while (end > start && isBlankOrNoise(lines[end - 1] ?? '')) end--;
  const kept = lines.slice(start, end).filter((line) => !(isUiNoise(line) && /\s/.test(line.trim())));
  return kept.some((line) => line.trim() !== '') ? kept : lines;
}

/** Drops a line identical to the previous non-empty line (sites often render text twice). */
function removeRepeatedLines(lines: string[]): string[] {
  const result: string[] = [];
  let previous = '';
  for (const line of lines) {
    const key = line.trim().replace(/\s+/g, ' ');
    if (key === '') {
      result.push(line);
      continue;
    }
    const isTableRow = line.includes('\t');
    if (key === previous && key.length >= MIN_DUPLICATE_LINE_LENGTH && !isTableRow) continue;
    previous = key;
    result.push(line);
  }
  return result;
}

/**
 * Collapses runs of spaces inside lines, but only when they are sporadic. If many lines
 * contain aligned spacing it's intentional (CLI output, ASCII tables) and is kept as is.
 */
function collapseStraySpaces(lines: string[]): string[] {
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  const withRuns = nonEmpty.filter((line) => /\S {2,}\S/.test(line)).length;
  if (withRuns === 0 || withRuns / nonEmpty.length >= 0.2) return lines;
  return lines.map((line) => line.replace(/(\S) {2,}(?=\S)/g, '$1 '));
}

function dedent(lines: string[]): string[] {
  let common: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (common === null) {
      common = indent;
    } else {
      let i = 0;
      while (i < common.length && i < indent.length && common[i] === indent[i]) i++;
      common = common.slice(0, i);
    }
    if (common === '') return lines;
  }
  const prefix = common ?? '';
  return prefix ? lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line)) : lines;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
}
