import { SITE_NAMES, type Conversation } from '../core/types';
import { escapeHtml, renderMarkdown, safeHref } from '../render/markdown';
import { formatDateTime, hostOf, roleLabel } from './labels';

/**
 * Standalone HTML: one self-contained file that opens anywhere. Inline CSS only (no scripts, no
 * fonts, nothing loaded from the network, enforced by a Content-Security-Policy), light and dark
 * from the reader's system setting, styled code blocks. Message bodies go through the same safe
 * renderer as the print view (src/render/markdown.ts), which escapes every character of the
 * conversation, so nothing in a chat can become markup.
 */

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d2125; --muted: #5c6670; --border: #dde2e6; --soft: #f4f6f8; --code: #f6f8fa; --accent: #0c7385; --link: #0c6a7a; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #15181b; --fg: #e6e9ec; --muted: #a2abb3; --border: #30363c; --soft: #1e2226; --code: #1a1d21; --accent: #3fc1d4; --link: #6fd0de; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
a { color: var(--link); }
header { padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
h1.title { margin: 0 0 .35rem; font-size: 1.75rem; line-height: 1.25; letter-spacing: -.01em; overflow-wrap: anywhere; }
.meta { margin: 0; color: var(--muted); font-size: .875rem; }
.note { margin: 1rem 0 0; padding: .6rem .8rem; border-radius: 8px; background: var(--soft); color: var(--muted); font-size: .875rem; }
.message { padding: 1.25rem 0; border-bottom: 1px solid var(--border); }
.role { display: flex; align-items: center; gap: .5rem; margin: 0 0 .6rem; font-size: .75rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.role::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--muted); }
.assistant .role { color: var(--accent); }
.assistant .role::before { background: var(--accent); }
.user .content { padding: .75rem 1rem; border-radius: 10px; background: var(--soft); }
.content { overflow-wrap: anywhere; }
.content > :first-child { margin-top: 0; }
.content > :last-child { margin-bottom: 0; }
.content h1, .content h2, .content h3, .content h4, .content h5, .content h6 { margin: 1.25rem 0 .5rem; line-height: 1.3; }
.content h1 { font-size: 1.45rem; } .content h2 { font-size: 1.28rem; } .content h3 { font-size: 1.12rem; } .content h4, .content h5, .content h6 { font-size: 1rem; }
.content p, .content ul, .content ol, .content blockquote, .content table { margin: 0 0 1rem; }
.content ul, .content ol { padding-left: 1.5rem; }
.content li + li { margin-top: .2rem; }
.content li.task { list-style: none; }
.content li.task input { margin: 0 .35rem 0 -1.3rem; }
.content blockquote { padding: .1rem 0 .1rem 1rem; border-left: 3px solid var(--border); color: var(--muted); }
.content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86em; padding: .1em .3em; border-radius: 5px; background: var(--code); }
.content .code-block { margin: 0 0 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--code); overflow: hidden; }
.content .code-language { padding: .35rem .75rem; border-bottom: 1px solid var(--border); font: 600 .72rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); }
.content pre { margin: 0; padding: .75rem; overflow-x: auto; font-size: .82rem; line-height: 1.55; }
.content pre code { padding: 0; background: none; font-size: inherit; }
.content table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; font-size: .9rem; }
.content th, .content td { padding: .35rem .6rem; border: 1px solid var(--border); text-align: left; }
.content th { background: var(--soft); }
.content hr { border: 0; border-top: 1px solid var(--border); margin: 1.25rem 0; }
.content .math-display { margin: 0 0 1rem; padding: .5rem .75rem; border-radius: 8px; background: var(--code); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86rem; white-space: pre-wrap; }
.content .math-inline { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86em; }
.incomplete { margin: .6rem 0 0; color: var(--muted); font-size: .875rem; font-style: italic; }
footer { margin-top: 1.5rem; color: var(--muted); font-size: .8125rem; }
@media print {
  :root { color-scheme: light; --bg: #fff; --fg: #111; --muted: #555; --border: #ddd; --soft: #f5f5f5; --code: #f7f7f7; --accent: #0c6a7a; --link: #111; }
  main { max-width: none; padding: 0; }
  .message { break-inside: auto; }
  .role { break-after: avoid; }
}
`;

export function toHtmlDocument(conversation: Conversation, exportedAt: Date): string {
  const site = SITE_NAMES[conversation.site];
  const href = safeHref(conversation.url);
  const domain = hostOf(conversation.url);
  const count = conversation.messages.length;
  const meta = [
    `<span>${escapeHtml(site)}</span>`,
    domain ? `<span>${escapeHtml(domain)}</span>` : '',
    href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">Open original</a>` : '',
    `<span>Exported ${escapeHtml(formatDateTime(exportedAt))}</span>`,
    `<span>${count} ${count === 1 ? 'message' : 'messages'}</span>`,
  ].filter(Boolean);
  const messages = conversation.messages.map((message) =>
    [
      `<section class="message ${message.role}">`,
      `<div class="role">${escapeHtml(roleLabel(message.role, conversation.site))}</div>`,
      `<div class="content">${renderMarkdown(message.markdown)}</div>`,
      message.incomplete ? '<p class="incomplete">(Incomplete: still being generated.)</p>' : '',
      '</section>',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="generator" content="Chat Exporter">
<title>${escapeHtml(conversation.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1 class="title">${escapeHtml(conversation.title)}</h1>
<p class="meta">${meta.join(' · ')}</p>
${conversation.streaming ? '<p class="note">The last reply was still being generated when this was exported.</p>\n' : ''}</header>
${messages.join('\n')}
<footer>Exported with Chat Exporter.</footer>
</main>
</body>
</html>
`;
}
