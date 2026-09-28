import { SITE_NAMES, type Conversation, type Message } from './types';

/**
 * "Continue in another AI": a paste-ready prompt that hands a conversation over to another chat.
 * The most recent messages go in full; older ones are cut to their first lines, but their code
 * blocks are kept whole (code is what a follow-up usually needs). Pure, no DOM.
 */

/** Messages at the end that are always included in full. */
export const HANDOFF_RECENT = 6;
/** First lines of an older message, at most this many characters. */
const OLDER_MAX_CHARS = 240;
const OLDER_MAX_LINES = 2;

export interface Handoff {
  text: string;
  characters: number;
  /** Rough estimate (see estimateTokens). */
  tokens: number;
  /** Messages included in full / shortened. */
  full: number;
  shortened: number;
}

export function buildHandoff(conversation: Conversation, recent: number = HANDOFF_RECENT): Handoff {
  const site = SITE_NAMES[conversation.site];
  const messages = conversation.messages;
  const split = Math.max(0, messages.length - Math.max(1, recent));
  const label = (message: Message) => (message.role === 'user' ? 'User' : site);

  const blocks: string[] = [];
  messages.forEach((message, index) => {
    if (index < split) {
      blocks.push(`[${label(message)}, shortened]\n${shortenMessage(message.markdown)}`);
      return;
    }
    const body = message.markdown.trim() || '(empty)';
    blocks.push(`[${label(message)}${message.incomplete ? ', cut off' : ''}]\n${body}`);
  });

  const intro = [`Here is our earlier conversation from ${site}. Continue from where it ends.`, '', `Title: ${conversation.title.replace(/\s+/g, ' ').trim()}`];
  if (split > 0) {
    intro.push(`The first ${plural(split, 'message')} ${split === 1 ? 'is' : 'are'} shortened to ${split === 1 ? 'its' : 'their'} first lines (code is kept); the last ${plural(messages.length - split, 'message')} ${messages.length - split === 1 ? 'is' : 'are'} complete.`);
  }
  const text = `${intro.join('\n')}\n\n<conversation>\n${blocks.join('\n\n')}\n</conversation>\n`;
  return { text, characters: text.length, tokens: estimateTokens(text), full: messages.length - split, shortened: split };
}

/** The first lines of a message's prose, plus every code block in full. */
export function shortenMessage(markdown: string): string {
  const prose: string[] = [];
  const code: string[] = [];
  let more = false;
  let fence: { char: string; length: number; lines: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (fence) {
      fence.lines.push(line);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) {
        code.push(fence.lines.join('\n'));
        fence = null;
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open?.[1]) {
      fence = { char: open[1][0] ?? '`', length: open[1].length, lines: [line] };
      continue;
    }
    if (!line.trim()) continue;
    if (prose.length < OLDER_MAX_LINES) prose.push(line.trim());
    else more = true;
  }
  if (fence) code.push(fence.lines.join('\n'));

  let first = prose.join('\n');
  if (first.length > OLDER_MAX_CHARS) {
    const cut = first.slice(0, OLDER_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    first = (space > OLDER_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd();
    more = true;
  }
  if (more && first) first += ' …';
  const parts = [first, ...code].filter(Boolean);
  return parts.length ? parts.join('\n\n') : '(empty)';
}

/**
 * A rough token count, good enough to see whether a prompt fits: about 4 characters per token for
 * English and code, about 2 for other scripts. Real tokenizers differ by model.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.max(text ? 1 : 0, Math.round(ascii / 4 + other / 2));
}

const NUMBER = new Intl.NumberFormat('en-US');

/** "4,210 characters · ≈1,050 tokens". */
export function describeSize(handoff: Pick<Handoff, 'characters' | 'tokens'>): string {
  return `${NUMBER.format(handoff.characters)} characters · ≈${NUMBER.format(handoff.tokens)} tokens`;
}

/** "≈850 tokens", "≈1.2k tokens", "≈36k tokens". */
export function compactTokens(tokens: number): string {
  if (tokens < 1000) return `≈${tokens} tokens`;
  const thousands = tokens / 1000;
  return `≈${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k tokens`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
