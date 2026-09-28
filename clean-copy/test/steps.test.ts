import { describe, expect, it } from 'vitest';
import { applyEditsToText, type StepResult } from '../src/core/changes';
import { collapseSpacesStep, invisibleStep, isListLine, mergeLinesStep, stripBulletsStep, tidyStep, trailingSpaceStep } from '../src/core/steps';
import { removeInvisible, tidyText } from '../src/core/text';

/**
 * The steps report edits, and the edits must reproduce the step's own output. The reference
 * implementations below are the string-only versions the steps replaced.
 */

function referenceCollapse(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return indent + line.slice(indent.length).replace(/ {2,}/g, ' ').replace(/ +(?=\t)|(?<=\t) +/g, '').trimEnd();
    })
    .join('\n');
}

function referenceMerge(text: string): string {
  const out: string[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      out.push('');
      open = false;
      continue;
    }
    const table = line.includes('\t');
    const previous = out[out.length - 1];
    if (!open || previous === undefined || isListLine(line) || table || previous.includes('\t')) {
      out.push(line);
      open = !table;
      continue;
    }
    const next = line.trim();
    out[out.length - 1] = /\p{Ll}-$/u.test(previous) && /^\p{Ll}/u.test(next) ? previous.slice(0, -1) + next : `${previous.trimEnd()} ${next}`;
  }
  return out.join('\n');
}

function referenceBullets(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!isListLine(line)) return line;
      if (/^[ \t]*[-*•◦▪‣–·][ \t]+/.test(line)) return line.replace(/^[ \t]*[-*•◦▪‣–·][ \t]+/, '');
      return line.replace(/^[ \t]*(\d{1,3}[.)][ \t]+)/, '$1');
    })
    .join('\n');
}

/** A small deterministic generator of messy text. */
function corpus(count: number): string[] {
  const pieces = ['a', 'word', 'exam-', 'ple', ' ', '  ', '\t', '\n', '\n\n\n', '- ', '• ', '  - ', '1. ', '2) ', 'x-', 'B', '​', '­', '  \n', ' \t '];
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = '';
    const length = 1 + Math.floor(random() * 24);
    for (let j = 0; j < length; j++) text += pieces[Math.floor(random() * pieces.length)];
    out.push(text);
  }
  return out;
}

function expectConsistent(input: string, step: StepResult, reference: string): void {
  expect(step.text).toBe(reference);
  expect(applyEditsToText(input, step.edits)).toBe(reference);
}

describe('steps report edits that reproduce their output', () => {
  const inputs = [
    ...corpus(400),
    'We rebuilt the\neditor from scr-\natch.\n\nNext para-\nGraph\n- item one\n  continued\n- item two\n1) first\nA\tB\n1\t2',
    'a    b\n    indented   code\nx\t\ty  ',
    'a  \n   \n\tb   c',
    '- a\n  • b\n* c\n  2. d\n-not a bullet\n– e',
  ];

  it('collapseSpaces', () => {
    for (const input of inputs) expectConsistent(input, collapseSpacesStep(input), referenceCollapse(input));
  });

  it('mergeLines', () => {
    for (const input of inputs) expectConsistent(input, mergeLinesStep(input), referenceMerge(input));
  });

  it('stripBullets', () => {
    for (const input of inputs) expectConsistent(input, stripBulletsStep(input), referenceBullets(input));
  });

  it('tidy, trailing spaces and invisible characters', () => {
    for (const input of inputs) {
      expectConsistent(input, tidyStep(input), tidyText(input));
      expectConsistent(input, trailingSpaceStep(input), input.replace(/[ \t]+$/gm, ''));
      expectConsistent(input, invisibleStep(input), removeInvisible(input.replace(/[   ]/g, ' ')));
    }
  });
});

describe('what each step reports', () => {
  it('merge lines: the joined line break, with the space that replaces it', () => {
    expect(mergeLinesStep('one\ntwo').edits).toEqual([{ start: 3, end: 4, insert: ' ', kind: 'line-break' }]);
    expect(mergeLinesStep('exam-\nple').edits).toEqual([{ start: 4, end: 6, kind: 'line-break' }]);
  });

  it('collapse spaces and bullets', () => {
    expect(collapseSpacesStep('a   b').edits).toEqual([{ start: 2, end: 4, kind: 'whitespace' }]);
    expect(stripBulletsStep('  • item\n1. one').edits).toEqual([{ start: 0, end: 4, kind: 'bullet' }]);
  });

  it('invisible characters, one edit per run', () => {
    expect(invisibleStep('a​​b﻿').edits).toEqual([
      { start: 1, end: 3, kind: 'invisible' },
      { start: 4, end: 5, kind: 'invisible' },
    ]);
  });
});
