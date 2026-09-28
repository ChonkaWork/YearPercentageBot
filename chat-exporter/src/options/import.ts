import { formatBytes, importHistory, ImportError, type ImportProgress, type ImportSummary } from '../core/import';
import { formatDate } from '../export/labels';
import { HistoryArchive, historyZipName, type HistoryEntry, type HistoryFormat } from '../export/history';
import type { ExportOptions } from '../export/options';
import { byId, h } from '../ui/dom';
import { downloadBlob } from '../ui/download';

/**
 * "Your whole history" on the options page: the user drops the data export (zip or
 * conversations.json), it is converted here (src/core/import → src/export/history) and saved as
 * one zip. States: idle (drop zone), working (progress, Cancel), done (summary), error.
 */

export interface ImportContext {
  /** The plan includes the history import. */
  allowed(): boolean;
  /** File name template, tags and callouts to use. */
  exportOptions(): ExportOptions;
}

const els = {
  locked: byId<HTMLDivElement>('import-locked'),
  idle: byId<HTMLDivElement>('import-idle'),
  dropZone: byId<HTMLDivElement>('drop-zone'),
  choose: byId<HTMLButtonElement>('choose-file'),
  file: byId<HTMLInputElement>('import-file'),
  format: byId<HTMLFieldSetElement>('import-format'),
  note: byId<HTMLDivElement>('import-note'),
  noteText: byId<HTMLDivElement>('import-note-text'),
  error: byId<HTMLDivElement>('import-error'),
  errorText: byId<HTMLDivElement>('import-error-text'),
  working: byId<HTMLDivElement>('import-working'),
  stage: byId<HTMLSpanElement>('import-stage'),
  cancel: byId<HTMLButtonElement>('import-cancel'),
  progress: byId<HTMLDivElement>('import-progress'),
  count: byId<HTMLDivElement>('import-count'),
  done: byId<HTMLDivElement>('import-done'),
  headline: byId<HTMLDivElement>('import-headline'),
  fileLine: byId<HTMLDivElement>('import-file-line'),
  skipped: byId<HTMLUListElement>('import-skipped'),
  recent: byId<HTMLOListElement>('import-recent'),
  again: byId<HTMLButtonElement>('import-again'),
  reset: byId<HTMLButtonElement>('import-reset'),
  status: byId<HTMLParagraphElement>('import-status'),
};

const NUMBER = new Intl.NumberFormat('en-US');
const RECENT = 5;

type State = 'idle' | 'working' | 'done';

let context: ImportContext;
let controller: AbortController | null = null;
let result: { name: string; blob: Blob } | null = null;

function show(state: State): void {
  els.idle.hidden = state !== 'idle';
  els.working.hidden = state !== 'working';
  els.done.hidden = state !== 'done';
}

function announce(text: string): void {
  els.status.textContent = text;
}

/** Locks the drop zone when the plan doesn't include the import (nothing is taken away). */
export function renderImportPlan(): void {
  const allowed = context.allowed();
  els.locked.hidden = allowed;
  els.dropZone.classList.toggle('disabled', !allowed);
  els.dropZone.setAttribute('aria-disabled', String(!allowed));
  els.choose.disabled = !allowed;
  els.file.disabled = !allowed;
  els.format.disabled = !allowed;
}

export function setupImport(importContext: ImportContext): void {
  context = importContext;
  renderImportPlan();
  els.choose.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    const file = els.file.files?.[0];
    els.file.value = '';
    if (file) void run(file);
  });

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  let depth = 0;
  els.dropZone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    if (context.allowed()) els.dropZone.classList.add('dragover');
  });
  els.dropZone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) els.dropZone.classList.remove('dragover');
  });
  els.dropZone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = context.allowed() ? 'copy' : 'none';
  });
  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    els.dropZone.classList.remove('dragover');
    const file = event.dataTransfer?.files[0];
    if (file && context.allowed()) void run(file);
  });
  // A file dropped next to the zone must not replace the options page with the file.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
  }

  els.cancel.addEventListener('click', () => controller?.abort());
  els.again.addEventListener('click', () => {
    if (result) downloadBlob(result.name, result.blob);
  });
  els.reset.addEventListener('click', () => {
    result = null;
    show('idle');
    els.choose.focus();
  });
}

async function run(file: File): Promise<void> {
  if (!context.allowed() || controller) return;
  els.error.hidden = true;
  els.note.hidden = true;
  const format = (document.querySelector<HTMLInputElement>('input[name="import-format"]:checked')?.value ?? 'obsidian') as HistoryFormat;
  const now = new Date();
  const archive = new HistoryArchive({ format, exportOptions: context.exportOptions(), now });
  controller = new AbortController();
  els.stage.textContent = `Reading ${file.name || 'the export'}…`;
  setProgress({ conversations: 0, bytesRead: 0, totalBytes: 1 });
  show('working');
  els.cancel.focus();
  announce('Import started.');

  let frame = 0;
  let latest: ImportProgress | null = null;
  const onProgress = (progress: ImportProgress) => {
    latest = progress;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (latest) setProgress(latest);
    });
  };

  try {
    const summary = await importHistory(file, {
      signal: controller.signal,
      onProgress,
      onConversation: async (conversation) => {
        await archive.add(conversation);
      },
    });
    els.stage.textContent = 'Writing the zip…';
    const parts = await archive.finish(summary);
    const blob = new Blob(parts as BlobPart[], { type: 'application/zip' });
    const name = historyZipName(summary.sources, now);
    result = { name, blob };
    downloadBlob(name, blob);
    renderSummary(summary, archive.entries, name, blob.size);
    show('done');
    els.again.focus();
    announce(`Done: ${plural(summary.conversations, 'conversation')} saved in ${name}.`);
  } catch (error) {
    show('idle');
    if (error instanceof ImportError && error.code === 'ABORTED') {
      els.noteText.textContent = 'Import cancelled. Nothing was saved.';
      els.note.hidden = false;
      announce('Import cancelled.');
    } else {
      els.errorText.textContent = error instanceof Error ? error.message : String(error);
      els.error.hidden = false;
      announce(els.errorText.textContent);
    }
    els.choose.focus();
  } finally {
    cancelAnimationFrame(frame);
    controller = null;
  }
}

function setProgress(progress: ImportProgress): void {
  const percent = progress.totalBytes > 0 ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100)) : 0;
  els.progress.setAttribute('aria-valuenow', String(percent));
  (els.progress.firstElementChild as HTMLElement).style.width = `${percent}%`;
  els.count.textContent = `${plural(progress.conversations, 'conversation')} · ${percent}%`;
}

function renderSummary(summary: ImportSummary, entries: readonly HistoryEntry[], name: string, size: number): void {
  els.headline.textContent = `${plural(summary.conversations, 'conversation')} · ${plural(summary.messages, 'message')}`;
  els.fileLine.textContent = `Downloaded ${name} (${formatBytes(size)}): one Markdown file per conversation and index.md. Read from ${summary.path}.`;

  const skipped = summary.skippedMessages;
  const lines: string[] = [];
  if (skipped.system) lines.push(`${plural(skipped.system, 'system or tool message')} (not shown in the chat)`);
  if (skipped.hidden) lines.push(`${plural(skipped.hidden, 'hidden message')}`);
  if (skipped.empty) lines.push(`${plural(skipped.empty, 'empty message')}`);
  const unsupported = Object.entries(skipped.unsupported).sort(([, a], [, b]) => b - a);
  if (unsupported.length) {
    const total = unsupported.reduce((sum, [, count]) => sum + count, 0);
    lines.push(`${plural(total, 'part')} with content that isn't text: ${unsupported.map(([type, count]) => `${type} (${NUMBER.format(count)})`).join(', ')}`);
  }
  if (summary.skippedConversations.empty) lines.push(`${plural(summary.skippedConversations.empty, 'conversation')} with nothing to export`);
  if (summary.skippedConversations.unrecognized) lines.push(`${plural(summary.skippedConversations.unrecognized, 'entry', 'entries')} that aren't ChatGPT or Claude conversations`);
  els.skipped.replaceChildren(...(lines.length ? lines : ['Nothing: every message was exported.']).map((line) => h('li', { text: line })));

  const recent = [...entries].sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity)).slice(0, RECENT);
  els.recent.replaceChildren(
    ...recent.map((entry) =>
      h(
        'li',
        {},
        h('span', { class: 'recent-date font-mono', text: entry.date ? formatDate(entry.date) : 'no date' }),
        h('span', { class: 'recent-title', text: entry.title, attrs: { title: entry.file } }),
        h('span', { class: 'recent-count tabular', text: plural(entry.messages, 'message') }),
      ),
    ),
  );
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${NUMBER.format(count)} ${count === 1 ? word : many}`;
}
