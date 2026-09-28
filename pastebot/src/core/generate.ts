import { getTemplate, type PromptSpec } from '../templates';
import { prepareContent } from './clean';
import { CONTENT_PLACEHOLDER_PATTERN } from './customTemplates';
import { MAX_CUSTOM_INSTRUCTION_CHARS, MAX_INPUT_CHARS } from './limits';
import { Masker } from './mask';
import { sanitizePageContext } from './pageContext';
import { fillVariables } from './variables';
import {
  isPromptAction,
  isPromptStyle,
  type ContentInfo,
  type PageContext,
  type PromptError,
  type PromptRequest,
  type PromptResult,
  type PromptStyle,
} from './types';

const CONCISE_OUTPUT = 'Keep the answer short and focused on what matters most.';
const DETAILED_OUTPUT = 'Be thorough, and use headings to structure the answer.';
const MATCH_LANGUAGE = 'Respond in the same language as the content.';

const CONTENT_LABELS: Record<ContentInfo['kind'], string> = {
  text: 'Content',
  code: 'Code',
  error: 'Error',
  table: 'Table',
};

const FENCE_LANGUAGES: Record<string, string> = {
  'C#': 'csharp',
  'C++': 'cpp',
  Shell: 'bash',
};

/**
 * Turns selected content into a ready-to-paste prompt. Pure and synchronous: no DOM,
 * no Chrome APIs, no network. Everything the extension shows or copies comes from here.
 */
export function generatePrompt(request: PromptRequest): PromptResult {
  const { action, selectedText } = request;
  if (!isPromptAction(action)) return error('UNKNOWN_ACTION', 'Unknown action.');
  const style: PromptStyle = isPromptStyle(request.style) ? request.style : 'balanced';

  const raw = typeof selectedText === 'string' ? selectedText : '';
  // Reject absurdly large input before doing any work on it.
  if (raw.length > MAX_INPUT_CHARS * 4) return tooLarge(raw.length);

  const prepared = prepareContent(raw);
  const { info } = prepared;
  if (!prepared.text.trim()) return error('EMPTY_TEXT', 'Select or paste some text first.');
  if (prepared.text.length > MAX_INPUT_CHARS) return tooLarge(prepared.text.length);

  const instruction = (request.customInstruction ?? '').trim();
  if (action === 'custom') {
    if (!instruction) return error('EMPTY_INSTRUCTION', 'Write what the AI should do with this text.');
    if (instruction.length > MAX_CUSTOM_INSTRUCTION_CHARS) {
      return error(
        'INSTRUCTION_TOO_LONG',
        `Keep the instruction under ${MAX_CUSTOM_INSTRUCTION_CHARS.toLocaleString('en-US')} characters.`,
      );
    }
  }

  // Masking runs after cleanup (so detection sees the original) and shares one mapping across the
  // content, the page title and URL, and {title}/{url} in templates.
  const masker = request.mask ? new Masker(request.mask) : null;
  const maskValue = (value: string) => (masker ? masker.mask(value) : value);
  const text = maskValue(prepared.text);
  const page = maskPage(sanitizePageContext(request.pageContext), maskValue);
  const variables = request.variables ?? null;
  const fill = (part: string) =>
    variables ? fillVariables(part, { ...variables, page: sanitizePageContext(variables.page) }, maskValue) : part;

  // Custom instructions (and custom templates) may place the content themselves: `{content}`.
  // Variables are filled on each side of it, so an answer can never move the content.
  const placeholder = action === 'custom' ? CONTENT_PLACEHOLDER_PATTERN.exec(instruction) : null;
  const template = getTemplate(action);
  const targetLanguage = request.targetLanguage?.trim() || 'English';
  const spec = template.build({ content: info, style, customInstruction: placeholder ? instruction : fill(instruction), targetLanguage });
  const output = outputLines(spec, style);
  if (template.matchContentLanguage && info.nonLatin) output.push(MATCH_LANGUAGE);

  if (placeholder) {
    const before = fill(instruction.slice(0, placeholder.index)).replace(/[ \t]+$/, '');
    const after = fill(instruction.slice(placeholder.index + placeholder[0].length)).replace(/^[ \t]+/, '');
    const inline = [
      before,
      before && !before.endsWith('\n') ? '\n' : '',
      contentBlock(text, info),
      after && !after.startsWith('\n') ? '\n' : '',
      after,
    ].join('');
    const prompt = [pageSection(page), inline, output.join('\n')]
      .filter((section) => section.trim() !== '')
      .join('\n\n');
    return { ok: true, prompt, content: info, masked: masker?.items ?? [], source: text };
  }

  const sections = [taskSection(spec, style), guidanceSection(spec), pageSection(page), contentSection(text, info), output.join('\n')];
  const prompt = sections.filter((section) => section.trim() !== '').join('\n\n');
  return { ok: true, prompt, content: info, masked: masker?.items ?? [], source: text };
}

function maskPage(page: PageContext | null, mask: (value: string) => string): PageContext | null {
  if (!page) return null;
  const result: PageContext = {};
  if (page.title) result.title = mask(page.title);
  if (page.url) result.url = mask(page.url);
  return result;
}

function taskSection(spec: PromptSpec, style: PromptStyle): string {
  if (style === 'concise') return spec.conciseTask ?? spec.task;
  const steps = [...(spec.steps ?? []), ...(style === 'detailed' ? (spec.detailedSteps ?? []) : [])];
  if (steps.length === 0) return spec.task;
  const list = steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  return `${spec.task}\n\n${spec.stepsIntro ?? 'Cover:'}\n${list}`;
}

function guidanceSection(spec: PromptSpec): string {
  return (spec.guidance ?? []).join(' ');
}

function outputLines(spec: PromptSpec, style: PromptStyle): string[] {
  const base = spec.output ?? [];
  if (style === 'concise') return spec.conciseOutput ? [...spec.conciseOutput] : [...base, CONCISE_OUTPUT];
  if (style === 'detailed') return spec.detailedOutput ? [...spec.detailedOutput] : [...base, DETAILED_OUTPUT];
  return [...base];
}

function pageSection(page: PageContext | null): string {
  if (!page) return '';
  const lines: string[] = [];
  if (page.title) lines.push(`Page: ${page.title}`);
  if (page.url) lines.push(`URL: ${page.url}`);
  return lines.join('\n');
}

function contentSection(text: string, info: ContentInfo): string {
  return `${CONTENT_LABELS[info.kind]}:\n${contentBlock(text, info)}`;
}

/** The content in quotes (prose) or a code fence (code, errors, tables), without a label. */
function contentBlock(text: string, info: ContentInfo): string {
  if (info.kind === 'text' && !text.includes('"""')) return `"""\n${text}\n"""`;
  const language = info.kind === 'code' && info.language ? fenceLanguage(info.language) : '';
  const fence = fenceFor(text);
  return `${fence}${language}\n${text}\n${fence}`;
}

function fenceLanguage(language: string): string {
  return FENCE_LANGUAGES[language] ?? language.toLowerCase();
}

/** A backtick fence longer than any backtick run inside the text, so it can't be closed early. */
function fenceFor(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function tooLarge(length: number): PromptError {
  return {
    ...error(
      'TEXT_TOO_LARGE',
      `The text is ${length.toLocaleString('en-US')} characters. The limit is ${MAX_INPUT_CHARS.toLocaleString('en-US')}.`,
    ),
    length,
    limit: MAX_INPUT_CHARS,
  };
}

function error(code: PromptError['code'], message: string): PromptError {
  return { ok: false, code, message };
}
