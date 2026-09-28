# Extensions design system

Shared rules for every Chrome extension in this repo. Each extension is a separate Chrome Web Store
listing with its own identity, but they are built from the same parts so they look finished, not
"default AI UI".

## Stack

- **Bootstrap 5.3** (`bootstrap@^5.3.8`), compiled from Sass (`sass@^1.105`) with a per-extension
  theme. Import only the partials you use (functions, variables, variables-dark, maps, mixins,
  utilities, root, reboot, type, buttons, forms, card, badge, list-group, nav, alert, progress,
  toasts, spinners, close, helpers, utilities/api). No CDN, everything is bundled locally
  (MV3 forbids remote code, and remote CSS/fonts leak browsing to third parties).
  - Dart Sass warns about Bootstrap's `@import` usage: compile with `quietDeps: true` and
    `silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function']`
    (sass 1.105 reports `mixed-decls` as obsolete, don't pass it).
  - Dark mode: `$color-mode-type: media-query` so it follows the OS without JS and without a flash.
  - Avoid Bootstrap's JS plugins unless a component really needs one; if so, import the single ES
    module (e.g. `bootstrap/js/dist/collapse`), never the whole bundle.
- **Icons: Bootstrap Icons** (`bootstrap-icons`). Import individual SVG files as text
  (esbuild `loader: { '.svg': 'text' }` / Vite `?raw`) and inline them. No icon font, no emoji as
  UI icons (emoji are fine inside user content or where a spec explicitly asks for them).
- **Fonts** (extension pages only, bundled from npm):
  - UI: **Manrope Variable** (`@fontsource-variable/manrope`, Latin + Cyrillic).
  - Code, prompts, prices, percentages: **JetBrains Mono Variable** (`@fontsource-variable/jetbrains-mono`),
    with `font-variant-numeric: tabular-nums` for numbers that update.
  - Only ship the `latin`, `latin-ext` and `cyrillic` subsets.
  - In-page UI (content scripts, shadow DOM) uses the system font stack: `@font-face` does not work
    inside shadow roots and loading fonts into pages is intrusive.
- **In-page UI** lives in a shadow root (see `pastebot/src/content/overlay.ts`). Compile a separate,
  smaller Sass entry for it, replace `:root` with `:host` in the output (Bootstrap defines its CSS
  variables on `:root`), skip `reboot`, and load it through `adoptedStyleSheets` (works under strict
  page CSP).

## Look and feel

- Calm, dense, utilitarian. It should feel like a sharp tool, not a landing page.
- No purple/indigo gradients, no glassmorphism, no "✨" sparkles, no giant rounded pills everywhere,
  no marketing copy inside the product.
- Radius: `$border-radius: .5rem`, `$border-radius-lg: .75rem`, `$border-radius-sm: .375rem`.
- Base font size: `0.875rem` (14px) in popups and in-page panels, `0.9375rem` (15px) on full pages.
- Spacing: Bootstrap's scale, mostly `2`/`3`. Popups use `p-3`, sections separated by `border-top`
  or small uppercase `text-body-secondary` headings (`.section-label`, 11px, letter-spacing .04em).
- Shadows: `$box-shadow-sm` for cards in light mode, borders instead of shadows in dark mode.
- Use real components: `card`, `list-group`, `badge`, `nav-pills`/`nav-underline`, `form-switch`,
  `input-group`, `btn-group`, `toast`, `progress`, `alert`, `placeholder` (loading skeletons).
- States are designed, not afterthoughts: loading (skeleton/spinner), empty (icon + one sentence +
  primary action), error (`alert` with what happened and what to do), success (toast or inline
  check).
- Accessibility: visible focus (`:focus-visible` ring in the brand color), 4.5:1 contrast for text
  in both themes, `aria-live` for async results, keyboard access for every action.
- Popups: width 360-400px, never horizontally scrollable, max height 600px (Chrome's limit).

## Brand per extension

Each extension sets `$primary` (and anything listed) in its own `src/styles/_theme.scss`.

| Extension | Folder | Primary | Notes |
| --- | --- | --- | --- |
| Pastebot | `pastebot/` | `#c4450d` burnt orange (icon `#e8590c`) | Light UI with warm paper background `#fffdf8` |
| Universal Copy | `universal-copy/` | `#0b7285` deep teal | |
| Clean Copy | `clean-copy/` | `#1971c2` blue | Minimal, lots of whitespace |
| Table Copy | `table-copy/` | `#2b8a3e` spreadsheet green (buttons 10% darker for contrast) | Grid/table motif in previews |
| Snippets (text expander) | `text-expander/` | `#c2255c` raspberry | |
| Chat Exporter | `chat-exporter/` | `#1098ad` cyan | |
| AI Chat Search | `ai-chat-search/` | `#e67700` amber | |
| Page Watch | `page-watch/` | `#e03131` alert red | |
| Video Speed+ | `video-speed/` | `#d6336c` magenta | Dark-first overlay on video |
| Progress Tab | `progress-tab/` | `#0ca678` mint (user themes) | Big calm typography |
| CryptoSignal AI | `crypto-signal/` | gold `#f0b90b`, up `#0ecb81`, down `#f6465d` | Dark only, bg `#0b0e11` |
| YouTube Focus | `youtube-focus/` | `#4d7c0f` olive | Viewfinder icon, no YouTube marks |
| Polymarket AI Analyzer | `polymarket-analyzer/` | `#2e5cff` | Dark only, bg `#0b1020`, up/down green/red |

Semantic colors stay Bootstrap's (`success`, `danger`, `warning`, `info`) unless listed above.

## Screenshots

Every extension commits curated screenshots to `<folder>/screenshots/` (generated by its e2e test,
light and dark where the UI supports both) and shows them in its README. `e2e/output/` stays
git-ignored.
