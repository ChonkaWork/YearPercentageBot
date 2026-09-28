import { MAX_CUSTOM_INSTRUCTION_CHARS } from './limits';
import { MAX_TEMPLATES } from './plan';

/**
 * Custom templates (Pro): the user's own actions. Each one is a name for menus and an
 * instruction that goes through the same generator as the Custom action, so cleanup,
 * content detection, prompt style and page context all still apply.
 */
export interface CustomTemplate {
  id: string;
  name: string;
  /** May contain `{content}` once, to place the selection inside the instruction. */
  instruction: string;
}

export const MAX_TEMPLATE_NAME_CHARS = 40;
export const CONTENT_PLACEHOLDER = '{content}';
/** `{content}`, tolerant of spaces and case: `{ Content }`. */
export const CONTENT_PLACEHOLDER_PATTERN = /\{\s*content\s*\}/i;
const ALL_PLACEHOLDERS = /\{\s*content\s*\}/gi;

export type TemplateDraft = Pick<CustomTemplate, 'name' | 'instruction'>;

export type TemplateValidation =
  | { ok: true; value: TemplateDraft }
  | { ok: false; field: 'name' | 'instruction'; message: string };

/** Normalizes and checks a template from the editor. Names are unique (case-insensitive). */
export function validateTemplate(
  draft: TemplateDraft,
  existing: readonly CustomTemplate[] = [],
  editingId?: string,
): TemplateValidation {
  const name = normalizeName(draft.name);
  const instruction = draft.instruction.trim();
  if (!name) return { ok: false, field: 'name', message: 'Give the template a name.' };
  if (name.length > MAX_TEMPLATE_NAME_CHARS) {
    return { ok: false, field: 'name', message: `Keep the name under ${MAX_TEMPLATE_NAME_CHARS} characters.` };
  }
  const duplicate = existing.some((template) => template.id !== editingId && template.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return { ok: false, field: 'name', message: 'There is already a template with this name.' };
  if (!instruction) return { ok: false, field: 'instruction', message: 'Write what the AI should do with the text.' };
  if (instruction.length > MAX_CUSTOM_INSTRUCTION_CHARS) {
    return {
      ok: false,
      field: 'instruction',
      message: `Keep the instruction under ${MAX_CUSTOM_INSTRUCTION_CHARS.toLocaleString('en-US')} characters.`,
    };
  }
  if ((instruction.match(ALL_PLACEHOLDERS) ?? []).length > 1) {
    return { ok: false, field: 'instruction', message: `Use ${CONTENT_PLACEHOLDER} at most once.` };
  }
  if (!instruction.replace(ALL_PLACEHOLDERS, '').trim()) {
    return { ok: false, field: 'instruction', message: `Add an instruction around ${CONTENT_PLACEHOLDER}.` };
  }
  return { ok: true, value: { name, instruction } };
}

/** Adds (no id match) or replaces a template. The caller validates first. */
export function upsertTemplate(templates: readonly CustomTemplate[], template: CustomTemplate): CustomTemplate[] {
  const index = templates.findIndex((existing) => existing.id === template.id);
  if (index === -1) return [...templates, template];
  return templates.map((existing, i) => (i === index ? template : existing));
}

export function removeTemplate(templates: readonly CustomTemplate[], id: string): CustomTemplate[] {
  return templates.filter((template) => template.id !== id);
}

/** Moves a template up (-1) or down (+1). Out-of-range moves leave the list as is. */
export function moveTemplate(templates: readonly CustomTemplate[], id: string, delta: -1 | 1): CustomTemplate[] {
  const from = templates.findIndex((template) => template.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= templates.length) return [...templates];
  const next = [...templates];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** Drops anything malformed read back from storage (bad entries, duplicate ids, overflow). */
export function sanitizeTemplates(raw: unknown): CustomTemplate[] {
  if (!Array.isArray(raw)) return [];
  const templates: CustomTemplate[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) continue;
    if (typeof entry.name !== 'string' || typeof entry.instruction !== 'string') continue;
    const name = normalizeName(entry.name).slice(0, MAX_TEMPLATE_NAME_CHARS);
    const instruction = entry.instruction.trim().slice(0, MAX_CUSTOM_INSTRUCTION_CHARS);
    if (!name || !instruction) continue;
    ids.add(entry.id);
    templates.push({ id: entry.id, name, instruction });
    if (templates.length >= MAX_TEMPLATES) break;
  }
  return templates;
}

export function findTemplate(templates: readonly CustomTemplate[], id: string): CustomTemplate | undefined {
  return templates.find((template) => template.id === id);
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}
