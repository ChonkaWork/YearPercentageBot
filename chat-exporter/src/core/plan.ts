/**
 * Free vs Pro (see docs/MONETIZATION.md at the repo root). Pure: no Chrome APIs, no payment code.
 * A future `src/payments/` adapter sets the stored plan; every Pro check goes through this file.
 *
 * Free: copy as Markdown, download .md, .txt and .html, select messages, hand-off to another AI.
 * Pro: everything below.
 */

export type Plan = 'free' | 'pro';

export type ProFeature =
  /** Download the versioned JSON export. */
  | 'json'
  /** Print view (Save as PDF). */
  | 'pdf'
  /** Markdown with YAML front matter (and optional callouts) for Obsidian / Notion. */
  | 'obsidian'
  /** Include/exclude code and user messages, last N messages, file name template. */
  | 'export-options'
  /** The whole history from the official ChatGPT / Claude data export, as one zip of Markdown files. */
  | 'history-import';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';

/** What the "About Pro" card lists, in order. */
export const PRO_FEATURES: readonly { feature: ProFeature; title: string; description: string }[] = [
  {
    feature: 'history-import',
    title: 'Your whole history',
    description: 'Drop the data export from ChatGPT or Claude and get every conversation as a Markdown file, with an index, in one zip.',
  },
  { feature: 'json', title: 'JSON export', description: 'The whole conversation as versioned JSON, for scripts and archives.' },
  { feature: 'pdf', title: 'PDF', description: 'A clean print view of the conversation; save it as PDF from the print dialog.' },
  {
    feature: 'obsidian',
    title: 'Obsidian / Notion Markdown',
    description: 'YAML front matter (title, source, url, date, tags) and optional callouts for each role.',
  },
  {
    feature: 'export-options',
    title: 'Export options',
    description: 'Leave out code blocks or your own messages, export only the last N messages, and name files with a template.',
  },
];

export interface Limits {
  /** Download formats this plan can use. Copying (Markdown, hand-off) is always available. */
  formats: readonly ('markdown' | 'text' | 'html' | 'obsidian' | 'json' | 'pdf')[];
  /** Export options (code, user messages, last N, file name template) are applied. */
  exportOptions: boolean;
  /** The official data export can be turned into Markdown files. */
  historyImport: boolean;
}

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/** The stored plan, sanitized: anything unexpected is 'free'. */
export function sanitizePlan(raw: unknown): Plan {
  return isPlan(raw) ? raw : 'free';
}

export function hasFeature(plan: Plan, _feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return earlyAccess || plan === 'pro';
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): Limits {
  const has = (feature: ProFeature) => hasFeature(plan, feature, earlyAccess);
  return {
    formats: [
      'markdown',
      'text',
      'html',
      ...(has('obsidian') ? (['obsidian'] as const) : []),
      ...(has('json') ? (['json'] as const) : []),
      ...(has('pdf') ? (['pdf'] as const) : []),
    ],
    exportOptions: has('export-options'),
    historyImport: has('history-import'),
  };
}

/** The calm message shown when a free user picks a Pro feature. */
export function proMessage(feature: ProFeature): string {
  const title = PRO_FEATURES.find((item) => item.feature === feature)?.title ?? 'This';
  return `${title} is part of Pro (${PRO_PRICE}, one-time). Free keeps copying and .md, .txt and .html downloads.`;
}
