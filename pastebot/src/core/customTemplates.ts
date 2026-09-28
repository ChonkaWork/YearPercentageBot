import { MAX_CUSTOM_INSTRUCTION_CHARS } from './limits';
import { MAX_TEMPLATES } from './plan';
import { variableProblem } from './variables';

/**
 * Custom templates (Pro): the user's own actions. Each one is a name for menus and an
 * instruction that goes through the same generator as the Custom action, so cleanup,
 * content detection, prompt style and page context all still apply.
 */
export interface CustomTemplate {
  id: string;
  name: string;
  /**
   * May contain `{content}` (or `{selection}`) once, to place the selection inside the
   * instruction, and variables (see variables.ts): `{title}`, `{url}`, `{date}`, `{{Asked}}`.
   */
  instruction: string;
}

export const MAX_TEMPLATE_NAME_CHARS = 40;
export const CONTENT_PLACEHOLDER = '{content}';
/** `{content}` or its alias `{selection}`, tolerant of spaces and case: `{ Content }`. Never inside `{{…}}`. */
export const CONTENT_PLACEHOLDER_PATTERN = /(?<!\{)\{\s*(?:content|selection)\s*\}(?!\})/i;
const ALL_PLACEHOLDERS = /(?<!\{)\{\s*(?:content|selection)\s*\}(?!\})/gi;

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
    return { ok: false, field: 'instruction', message: `Use ${CONTENT_PLACEHOLDER} (or {selection}) at most once.` };
  }
  if (!instruction.replace(ALL_PLACEHOLDERS, '').trim()) {
    return { ok: false, field: 'instruction', message: `Add an instruction around ${CONTENT_PLACEHOLDER}.` };
  }
  const problem = variableProblem(instruction);
  if (problem) return { ok: false, field: 'instruction', message: problem };
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

// --- Import and export (Pro) ------------------------------------------------------------

export const TEMPLATES_FILE_FORMAT = 'pastebot-templates';
const TEMPLATES_FILE_VERSION = 1;

/** A JSON file with names and instructions only (ids are local to this browser). */
export function exportTemplates(templates: readonly CustomTemplate[], exportedAt: Date = new Date()): string {
  const file = {
    format: TEMPLATES_FILE_FORMAT,
    version: TEMPLATES_FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    templates: templates.map(({ name, instruction }) => ({ name, instruction })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ImportResult =
  | { ok: true; templates: CustomTemplate[]; added: number; updated: number; unchanged: number; skipped: number }
  | { ok: false; message: string };

/**
 * Merges an exported file into the user's templates. A template with the same name (any case)
 * gets the imported instruction and keeps its id and place; new ones are added at the end.
 * Invalid entries and anything over `max` are skipped, never half-imported.
 */
export function importTemplates(
  existing: readonly CustomTemplate[],
  json: string,
  newId: () => string,
  max: number = MAX_TEMPLATES,
): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, message: "This file isn't valid JSON." };
  }
  const file = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (file && file.format !== undefined && file.format !== TEMPLATES_FILE_FORMAT) {
    return { ok: false, message: "This file wasn't exported by Pastebot." };
  }
  const list = Array.isArray(data) ? data : Array.isArray(file?.templates) ? (file.templates as unknown[]) : null;
  if (!list) return { ok: false, message: "This file doesn't contain Pastebot templates." };
  if (list.length === 0) return { ok: false, message: 'This file has no templates in it.' };

  let templates = [...existing];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const value of list) {
    const entry = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof entry.name !== 'string' || typeof entry.instruction !== 'string') {
      skipped += 1;
      continue;
    }
    const same = templates.find((template) => template.name.toLowerCase() === normalizeName(entry.name as string).toLowerCase());
    const result = validateTemplate({ name: entry.name, instruction: entry.instruction }, templates, same?.id);
    if (!result.ok) {
      skipped += 1;
    } else if (same) {
      if (same.instruction === result.value.instruction) {
        unchanged += 1;
      } else {
        templates = upsertTemplate(templates, { ...same, instruction: result.value.instruction });
        updated += 1;
      }
    } else if (templates.length >= max) {
      skipped += 1;
    } else {
      templates = [...templates, { id: newId(), ...result.value }];
      added += 1;
    }
  }
  return { ok: true, templates, added, updated, unchanged, skipped };
}

/** "Imported 3 templates: 2 new, 1 updated. 1 skipped (invalid or over the limit)." */
export function importSummary(result: Extract<ImportResult, { ok: true }>): string {
  const changed = result.added + result.updated;
  const parts: string[] = [];
  if (result.added) parts.push(`${result.added} new`);
  if (result.updated) parts.push(`${result.updated} updated`);
  let summary =
    changed === 0 ? 'Nothing new to import.' : `Imported ${changed} ${changed === 1 ? 'template' : 'templates'}: ${parts.join(', ')}.`;
  if (result.unchanged) summary += ` ${result.unchanged} already up to date.`;
  if (result.skipped) summary += ` ${result.skipped} skipped (invalid or over the limit of ${MAX_TEMPLATES}).`;
  return summary;
}
