# YearPercentageBot + Chrome extensions

This repo contains:

- **YearPercentageBot**: a Spring Boot / Java 21 Telegram bot that posts year progress
  (`src/`, `./gradlew build`).
- **A portfolio of small Chrome extensions** (Manifest V3, TypeScript, Bootstrap 5.3), each in its
  own self-contained folder with a README, tests and screenshots.

| Extension | Folder | What it does |
| --- | --- | --- |
| Pastebot | [`pastebot/`](pastebot) | Selected text → ready-to-paste AI prompt |
| Universal Copy | [`universal-copy/`](universal-copy) | Copy as clean text, Markdown, HTML, or tables as CSV / TSV / Markdown / JSON |
| Clean Copy | [`clean-copy/`](clean-copy) | Copy without formatting; auto-clean every Ctrl+C on chosen sites |
| Table Copy | [`table-copy/`](table-copy) | Any HTML table to CSV, TSV, Markdown, JSON or .xlsx |
| Snippets | [`text-expander/`](text-expander) | Text expander: `;sig` → your signature, anywhere |
| Chat Exporter | [`chat-exporter/`](chat-exporter) | Export ChatGPT / Claude conversations to Markdown, JSON, text, PDF |
| AI Chat Search | [`ai-chat-search/`](ai-chat-search) | Local full-text search across your ChatGPT / Claude conversations |
| Page Watch | [`page-watch/`](page-watch) | Notifications when a page or part of it changes |
| Video Speed+ | [`video-speed/`](video-speed) | Keyboard and on-video speed control for any video |
| Progress Tab | [`progress-tab/`](progress-tab) | New tab: year / month / week / day progress and countdowns |
| CryptoSignal AI | [`crypto-signal/`](crypto-signal) | Transparent crypto momentum signal from technical indicators |
| Polymarket AI Analyzer | [`polymarket-analyzer/`](polymarket-analyzer) | What's happening in a Polymarket market, and why |
| YouTube Focus | [`youtube-focus/`](youtube-focus) | Hide Shorts, recommendations and comments on YouTube |

Free vs Pro and prices: [`docs/MONETIZATION.md`](docs/MONETIZATION.md). Store launch plan: [`docs/LAUNCH.md`](docs/LAUNCH.md).

- Product concepts, strategy and status of every extension: [`docs/CONCEPTS.md`](docs/CONCEPTS.md)
- Shared UI rules: [`docs/design-system.md`](docs/design-system.md)
- Conventions for working in this repo: [`CLAUDE.md`](CLAUDE.md)

## Try an extension

```bash
cd <folder>
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select
`<folder>/dist`. Each README has a "How to use" section.
