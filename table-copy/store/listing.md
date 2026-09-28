# Chrome Web Store listing: Table Copy

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/table-copy-<version>.zip`).

> **Name risk.** The store already has an extension called **"Table Copy"** with the same job
> (list the tables on a page, copy or download them as CSV / Excel / Markdown), plus
> "Copytables", "Web Table Copy" and "Table Column Copy". With the identical name this listing is
> hard to find and easy to confuse with the other one. Pick a distinct name before the first
> upload.

## Name

The store shows the manifest's `name` (≤ 75 characters), currently **Table Copy**. A longer,
searchable name such as "Table Copy: tables to CSV, XLSX, Markdown, JSON" only helps a little
while another "Table Copy" exists. Whatever you choose: set it as `name` in
`static/manifest.json` (keep `short_name` ≤ 12 characters), then re-run
`node scripts/store-assets.mjs` and `npm run package`.

## Short description (≤ 132 characters)

Any table or data grid as CSV, TSV (Excel, Sheets), Markdown, JSON or .xlsx. Record every row of scrolling grids; pick and merge.

## Category

Productivity (alternative: Tools)

## Detailed description

Get tables off web pages as data, not as a mess: every row, clean columns, the format you need.

Copying a table from a web page usually goes wrong: merged cells shift every column, commas break
the CSV, numbers paste as text, and Excel in your language wants semicolons. And the data grids
of web apps and dashboards only show 20 rows at a time, so every table tool copies 20 rows.
Table Copy reads the table the way a spreadsheet would, and records the rest as you scroll.

Record rows (Pro)
• Virtualized grids (AG Grid, MUI DataGrid, admin dashboards) keep only the rows on screen in
  the page, and paginated tables replace their rows when you click Next.
• Start Record rows on the table, then scroll through it or click the site's own Next button. A
  bar next to the table counts as you go: "Recording · 1,284 of 2,400 rows".
• Rows come out once each and in order, with the header from the first page. Stop, then copy
  CSV or TSV, download .xlsx or add them to the basket.
• Table Copy never scrolls or clicks anything by itself.

Copy any table (free)
• Right-click anywhere inside a table → Table Copy → CSV, TSV (Excel, Sheets), Markdown or JSON.
  No need to select text first.
• Or click the toolbar button (Alt+T): every table on the page is listed with a preview and its
  size, and hovering one outlines it on the page. Pick the format once at the top; one click
  copies.
• Works on real <table>s and on data grids built from divs with ARIA roles (AG Grid, MUI
  DataGrid and most dashboards).
• Download the table as a .csv, .tsv, .md or .json file.
• Open in Google Sheets: copies the table and opens a new sheet, ready to paste.
• Keep links: linked cells get a "Name URL" column, or [text](url) in Markdown.
• Merged cells (colspan/rowspan) become a proper grid; grouped headers become
  "Population / 2010".
• TSV pastes straight into Excel and Google Sheets as cells. Formula-like cells are protected.
• CSV with a comma or a semicolon (for Excel where decimals use a comma).
• Hidden rows, footnote markers, buttons and row checkboxes are left out.

Download .xlsx (Pro)
• A real Excel file: bold, frozen header, sized columns.
• Numbers become numbers you can sum and sort (1,250 → 1250, 12.5% → 12.5%), read the way the
  page's language writes them. Codes with leading zeros, long IDs, prices and dates stay exactly
  as on the page.

Column picker (Pro)
• Choose which columns you need, filter them by name in wide tables and drag them into your
  order before copying or downloading. The preview follows as you go.

Merge tables (Pro)
• Add tables from one page or many to a basket, then export them together: stacked into one
  table with columns lined up by name, optionally with source columns, or one sheet per table.
• A preview shows the merged rows and which columns matched in every table.

Private by design: everything runs on your computer. No account, no server, no analytics, no
network requests. Pages are read only when you use Table Copy on them; settings, the basket and
recordings stay in your browser.

Free vs Pro: copying tables and grids in every format, file downloads (CSV, TSV, Markdown, JSON),
Open in Google Sheets, Keep links, the table list and the shortcut are free. Record rows,
Download .xlsx, the column picker and merging tables are Pro ($2.99 once). During early access,
Pro is free for everyone.

## Single purpose

Export tables and data grids from web pages as data: copy them or save them as files (CSV, TSV,
Markdown, JSON, .xlsx), optionally with every row of a grid recorded as the user scrolls or pages
through it, with chosen columns, or merged with other tables the user collected.

## Permission justifications

- **activeTab**: read the tables of the current tab only after the user uses the context menu or
  opens the popup there.
- **scripting**: inject the table reader, the confirmation message, the table outline and the
  Record rows bar into that tab on demand. No content scripts run on pages otherwise; a
  recording watches only the table the user chose, until they stop it or leave the page.
- **contextMenus**: the "Table Copy" items (copy as CSV / TSV / Markdown / JSON, add to basket)
  on selected text, on a right-click anywhere in a page (the table under the click is used) and
  on links (table cells are often links).
- **storage**: the user's settings, the basket of tables and the last row recording the user
  made, stored locally.
- **offscreen**: a hidden extension page that writes the table to the clipboard for the
  background service worker (which has no clipboard access of its own).
- **clipboardWrite**: put the converted table on the clipboard.

No host permissions, no downloads permission (files are saved with a download link), no tabs
permission ("Open in Google Sheets" uses chrome.tabs.create, which needs none).

## Data usage (privacy practices form)

- Collects no user data. Tables are processed locally only when the user copies, records or
  collects them.
- The basket and the last recording (tables the user adds or records, with their page title and
  address) are stored in `chrome.storage.local` on the user's device and never transmitted. The
  user can remove, clear or discard them at any time.
- "Open in Google Sheets" opens https://sheets.new in a new tab (a navigation the user asked
  for); no table data is sent, the user pastes it from the clipboard.
- No remote code; all code and assets (including the fflate zip library) are in the package.

## Remote code

No. All code, fonts, icons and the fflate library are in the package.

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/table-copy/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

Generated by `node scripts/store-assets.mjs` from the e2e screenshots (fixture pages are served
as `stats.example.org`, `shop.example.com`, `store.example.net` and `app.example.com`, so no test
address shows). `toast-csv.png` and `page-outline.png` are left out on purpose: their fixture page
contains a formula-injection test row.

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The redesigned popup: format switch, every table with previews, Copy ▾ and tools |
| `assets/screenshot-2.png` | 1280×800 | Record rows (Pro) on an orders dashboard: the live counter "1,284 of 2,400 rows" |
| `assets/screenshot-3.png` | 1280×800 | Column picker with filter and drag handles (Pro) |
| `assets/screenshot-4.png` | 1280×800 | Basket with tables from two sites, merged preview and matched columns (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Dark mode: the popup and the basket; privacy |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

- [ ] Load `release/table-copy-<version>.zip` unpacked in normal Chrome.
- [ ] Alt+T and right-click → Table Copy on Wikipedia (a table with merged headers), a sortable
      data table on a stats site and a page with a strict CSP (GitHub). Right-click without
      selecting anything, inside a table and outside one.
- [ ] Real AG Grid and MUI DataGrid demo pages (ag-grid.com examples, mui.com/x/react-data-grid):
      the grid is listed, copies with the right headers, and Record rows collects a large
      virtualized grid while scrolling and a paginated grid with its Next button.
      (Only fixture markup modelled on them was tested: **unverified on the real libraries**.)
- [ ] Open in Google Sheets: the new sheet opens and Ctrl+V pastes cells. (**Unverified**.)
- [ ] Paste TSV into Google Sheets and desktop Excel: cells, not one column.
- [ ] Open a downloaded .xlsx in Excel, Google Sheets and Numbers: numbers sum, header frozen,
      leading-zero codes kept. (Only checked by parsing the file so far: **unverified in Excel**.)
- [ ] A downloaded .csv with Cyrillic or accented text opens correctly in Excel (UTF-8 BOM), and
      CSV with semicolons opens correctly with a Ukrainian or German locale.
- [ ] macOS: Alt+T (Option+T) is assigned in `chrome://extensions/shortcuts`; right-click in a
      table (macOS selects the word) copies that table.

## Notes for the reviewer

Open any page with an HTML table (for example a Wikipedia article) and click the toolbar button
or press Alt+T: every table is listed with a preview, a format switch at the top and a Copy
button with a menu (Download file, Open in Google Sheets, Keep links). Right-click inside a table
→ Table Copy for the same from the page. Record rows: on a page with a scrolling data grid (for
example an AG Grid demo), click the record button under the grid in the popup, scroll the grid,
then press Stop in the bar above it. No account or login is needed.

## Distinct from Universal Copy (store duplicate-functionality policy)

Table Copy is about tables as data: its primary features are the table list, recording every row
of scrolling and paginated grids, .xlsx files with real numbers, the column picker and merging
tables across pages. It doesn't copy ordinary selections
as text, Markdown or HTML. Different name, icon (green grid), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
