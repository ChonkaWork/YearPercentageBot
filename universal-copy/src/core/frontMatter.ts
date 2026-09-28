import { cleanPageUrl, pageLinkTitle } from './pageLink';
import { removeInvisible } from './text';

/**
 * Front matter for .md downloads (Pro): a YAML block at the top of the file that note apps
 * (Obsidian, Logseq, Jekyll, Hugo, Zettlr...) read as the note's properties.
 *
 *   ---
 *   title: "Night trains return to Central Europe"
 *   url: https://news.example.com/travel/night-trains-return
 *   author: "Marta Nowak"
 *   published: 2026-09-14
 *   clipped: 2026-09-28
 *   tags: [clippings, travel]
 *   ---
 *
 * The user edits a template of `key: {{variable}}` lines. Values are escaped for YAML by
 * type, a line whose only value is an empty variable is left out, and nothing in a value
 * can end the block or add keys. Pure.
 */

export type VariableKind = 'text' | 'url' | 'date' | 'list';

export interface FrontMatterVariable {
  name: string;
  label: string;
  kind: VariableKind;
  description: string;
}

export const FRONT_MATTER_VARIABLES: readonly FrontMatterVariable[] = [
  { name: 'title', label: 'Title', kind: 'text', description: 'Page title' },
  { name: 'url', label: 'URL', kind: 'url', description: 'Page address, tracking parameters removed' },
  { name: 'author', label: 'Author', kind: 'text', description: 'From the page’s author tags or byline' },
  { name: 'published', label: 'Published', kind: 'date', description: 'Publication date from the page (YYYY-MM-DD)' },
  { name: 'clipped', label: 'Clipped', kind: 'date', description: 'Today (YYYY-MM-DD)' },
  { name: 'tags', label: 'Tags', kind: 'list', description: 'Your default tags' },
  { name: 'site', label: 'Site', kind: 'text', description: 'Site name' },
  { name: 'description', label: 'Description', kind: 'text', description: 'The page’s summary' },
];

export const DEFAULT_FRONT_MATTER_TEMPLATE = [
  'title: {{title}}',
  'url: {{url}}',
  'author: {{author}}',
  'published: {{published}}',
  'clipped: {{clipped}}',
  'tags: {{tags}}',
].join('\n');

export const DEFAULT_TAGS = 'clippings';
export const MAX_TEMPLATE_LENGTH = 4000;
export const MAX_TAGS_LENGTH = 300;

/** What the page tells about itself (read by src/page/meta.ts). */
export interface PageMeta {
  title: string;
  url: string;
  author: string;
  published: string;
  description: string;
  site: string;
}

export type FrontMatterValues = Record<string, string | string[]>;

// --- Values ----------------------------------------------------------------------------------

function oneLine(value: string | null | undefined, max = 500): string {
  const clean = removeInvisible(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].length > max ? `${[...clean].slice(0, max - 1).join('').trimEnd()}…` : clean;
}

/** YYYY-MM-DD in local time. */
export function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A page's date (ISO, "March 3, 2026", "2026-03-03T10:00:00+02:00"...) as YYYY-MM-DD, or ''. */
export function normalizeDate(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/^\d+$/.test(value)) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return date.getFullYear() >= 1900 && date.getFullYear() <= 2200 ? isoDate(date) : '';
}

/** "clippings, reading list, #travel" → ["clippings", "reading-list", "travel"] (Obsidian-safe). */
export function parseTags(raw: string | null | undefined): string[] {
  const tags = (raw ?? '')
    .split(/[,;\n]+/)
    .map((tag) =>
      tag
        .trim()
        .replace(/^#+/, '')
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_/-]/gu, ''),
    )
    .filter(Boolean);
  return [...new Set(tags)].slice(0, 30);
}

export function frontMatterValues(meta: PageMeta, tags: string, now: Date): FrontMatterValues {
  const url = cleanPageUrl(meta.url) ?? '';
  return {
    title: oneLine(url ? pageLinkTitle(meta.title, url) : meta.title),
    url,
    author: oneLine(meta.author, 200),
    published: normalizeDate(meta.published),
    clipped: isoDate(now),
    tags: parseTags(tags),
    site: oneLine(meta.site, 200),
    description: oneLine(meta.description, 500),
  };
}

// --- YAML ------------------------------------------------------------------------------------

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A plain scalar YAML reads back as the same string (not a number, date, bool or null). */
function isSafePlain(value: string): boolean {
  if (!/^[\p{L}\p{N}_/][\p{L}\p{N}_/.-]*$/u.test(value)) return false;
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(value)) return false;
  return !/^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+|0x[\da-f]+|0o[0-7]+)$/i.test(value);
}

function yamlValue(value: string | string[], kind: VariableKind): string {
  if (kind === 'list') {
    const items = Array.isArray(value) ? value : parseTags(value);
    return `[${items.map((item) => (isSafePlain(item) ? item : quoted(item))).join(', ')}]`;
  }
  const text = oneLine(Array.isArray(value) ? value.join(', ') : value, 2000);
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (kind === 'url' && /^https?:\/\/[^\s"'#]*(?:#[^\s"']*)?$/.test(text)) return text;
  return quoted(text);
}

function isEmpty(value: string | string[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) ? value.length === 0 : !value.trim());
}

const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/gi;
const WHOLE_VALUE = /^(\s*[^\s:#][^:]*:\s*)\{\{\s*([a-z]+)\s*\}\}\s*$/i;

function variable(name: string): FrontMatterVariable | undefined {
  return FRONT_MATTER_VARIABLES.find((item) => item.name === name.toLowerCase());
}

/** Unescaped double quotes before `index` on the line: odd means we're inside a "string". */
function insideQuotes(line: string, index: number): boolean {
  let count = 0;
  for (let i = 0; i < index; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') count++;
  }
  return count % 2 === 1;
}

function templateLines(template: string): string[] {
  const lines = template.replace(/\r\n?/g, '\n').split('\n');
  // The --- fences are added here; tolerate templates that include them.
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  if (lines[0]?.trim() === '---') lines.shift();
  if (lines[lines.length - 1]?.trim() === '---') lines.pop();
  return lines;
}

/** The front matter block (with its --- fences and a trailing newline), or '' when there's nothing to write. */
export function renderFrontMatter(template: string, values: FrontMatterValues): string {
  const out: string[] = [];
  for (const line of templateLines(template)) {
    if (line.trim() === '---') continue;
    const whole = WHOLE_VALUE.exec(line);
    if (whole) {
      const known = variable(whole[2] ?? '');
      if (known) {
        const value = values[known.name];
        if (isEmpty(value)) continue;
        out.push(`${whole[1]}${yamlValue(value ?? '', known.kind)}`);
        continue;
      }
    }
    out.push(
      line.replace(PLACEHOLDER, (match: string, name: string, offset: number) => {
        const known = variable(name);
        if (!known) return match;
        const value = values[known.name];
        const text = oneLine(Array.isArray(value) ? value.join(', ') : (value ?? ''), 2000);
        return insideQuotes(line, offset) ? text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : text;
      }),
    );
  }
  const body = out.filter((line) => line.trim() !== '');
  return body.length ? `---\n${body.join('\n')}\n---\n` : '';
}

/** Front matter (if any) and the Markdown, separated by a blank line. */
export function withFrontMatter(frontMatter: string, markdown: string): string {
  return frontMatter ? `${frontMatter}\n${markdown.replace(/^\n+/, '')}` : markdown;
}

// --- Checking the template (options page) ------------------------------------------------------

export interface TemplateIssue {
  line: number;
  message: string;
}

const KEY_LINE = /^[^\s:#-][^:]*:(?:\s|$)/;
const LIST_LINE = /^\s*-\s/;
const INDENTED = /^\s+\S/;
const COMMENT = /^\s*#/;

export function checkTemplate(template: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const keys = new Map<string, number>();
  const known = FRONT_MATTER_VARIABLES.map((item) => item.name).join(', ');
  template
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      const number = index + 1;
      if (!line.trim() || COMMENT.test(line) || line.trim() === '---') return;
      for (const match of line.matchAll(PLACEHOLDER)) {
        if (!variable(match[1] ?? '')) issues.push({ line: number, message: `Unknown variable ${match[0]}. Available: ${known}.` });
      }
      const stray = line.replace(PLACEHOLDER, '');
      if (/\{\{|\}\}/.test(stray)) issues.push({ line: number, message: 'A variable is missing its {{ or }}.' });
      if (KEY_LINE.test(line)) {
        const key = line.slice(0, line.indexOf(':')).trim();
        const first = keys.get(key);
        if (first !== undefined) issues.push({ line: number, message: `"${key}" is already set on line ${first}.` });
        else keys.set(key, number);
      } else if (!LIST_LINE.test(line) && !INDENTED.test(line)) {
        issues.push({ line: number, message: 'Each line needs a name and a value, like "source: {{url}}".' });
      }
    });
  if (template.length > MAX_TEMPLATE_LENGTH) issues.push({ line: 0, message: `The template is longer than ${MAX_TEMPLATE_LENGTH} characters.` });
  return issues;
}

/** Values for the template preview on the options page. */
export const SAMPLE_VALUES: FrontMatterValues = {
  title: 'Night trains return to Central Europe',
  url: 'https://news.example.com/travel/night-trains-return',
  author: 'Marta Nowak',
  published: '2026-09-14',
  clipped: '2026-09-28',
  tags: ['clippings'],
  site: 'The Daily Courier',
  description: 'Sleeper services link Vienna, Rome and Amsterdam again from December.',
};
