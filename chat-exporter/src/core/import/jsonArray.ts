/**
 * Splits a JSON array that arrives in text chunks into the source text of its elements, so a
 * conversations.json of hundreds of megabytes can be parsed one conversation at a time instead
 * of as one giant string and object graph.
 *
 * Only the array's own structure is tracked (strings, escapes, nesting); each element is then
 * checked by JSON.parse. Chunks may split anywhere, including inside strings and escapes.
 */

export type JsonArrayErrorCode = 'NOT_ARRAY' | 'SYNTAX' | 'TRUNCATED' | 'EMPTY';

export class JsonArrayError extends Error {
  constructor(readonly code: JsonArrayErrorCode) {
    super(`JSON array: ${code}`);
    this.name = 'JsonArrayError';
  }
}

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const BOM = 0xfeff;

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

export class JsonArraySplitter {
  private started = false;
  private finished = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private inElement = false;
  /** At least one element was found (so a separator without an element is an error). */
  private seenElement = false;
  /** Text of the current element from earlier chunks. */
  private pending: string[] = [];

  /** Feeds the next chunk; returns the elements completed by it (source text, trimmed). */
  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (code === BACKSLASH) this.escaped = true;
        else if (code === QUOTE) this.inString = false;
        continue;
      }
      if (!this.started) {
        if (isSpace(code) || code === BOM) continue;
        if (code !== OPEN_BRACKET) throw new JsonArrayError('NOT_ARRAY');
        this.started = true;
        this.depth = 1;
        continue;
      }
      if (this.finished) {
        if (isSpace(code)) continue;
        throw new JsonArrayError('SYNTAX');
      }
      if (this.depth === 1) {
        if (code === COMMA || code === CLOSE_BRACKET) {
          if (this.inElement) {
            out.push(this.take(chunk, start, i));
          } else if (code === COMMA || this.seenElement) {
            // "[,", ",," or ",]": a missing element. ("[]" is fine.)
            throw new JsonArrayError('SYNTAX');
          }
          if (code === CLOSE_BRACKET) {
            this.finished = true;
            this.depth = 0;
          }
          continue;
        }
        if (!this.inElement) {
          if (isSpace(code)) continue;
          this.inElement = true;
          this.seenElement = true;
          start = i;
        }
      }
      if (code === QUOTE) this.inString = true;
      else if (code === OPEN_BRACE || code === OPEN_BRACKET) this.depth++;
      else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
        this.depth--;
        if (this.depth < 1) throw new JsonArrayError('SYNTAX');
      }
    }
    if (this.inElement) this.pending.push(chunk.slice(start));
    return out;
  }

  /** Call after the last chunk. Throws when the array never started or didn't end. */
  end(): void {
    if (!this.started) throw new JsonArrayError('EMPTY');
    if (!this.finished) throw new JsonArrayError('TRUNCATED');
  }

  private take(chunk: string, start: number, end: number): string {
    const text = (this.pending.length ? this.pending.join('') + chunk.slice(start, end) : chunk.slice(start, end)).trim();
    this.pending = [];
    this.inElement = false;
    return text;
  }
}
