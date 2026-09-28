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

Any HTML table as CSV, TSV (Excel, Sheets), Markdown, JSON or .xlsx. Pick columns and merge tables from several pages.

## Category

Productivity (alternative: Tools)

## Detailed description

Get tables off web pages as data, not as a mess.

Copying a table from a web page usually goes wrong: merged cells shift every column, commas break
the CSV, numbers paste as text, and Excel in your language wants semicolons. Table Copy reads the
table the way a spreadsheet would and gives you clean data.

Copy any table (free)
• Right-click inside a table → Table Copy → CSV, TSV (Excel, Sheets), Markdown or JSON.
• Or click the toolbar button (Alt+T): every table on the page is listed with a preview and its
  size. One click copies the one you want.
• Merged cells (colspan/rowspan) become a proper grid; grouped headers become
  "Population / 2010".
• TSV pastes straight into Excel and Google Sheets as cells. Formula-like cells are protected.
• CSV with a comma or a semicolon (for Excel where decimals use a comma).
• Markdown for GitHub, notes and AI chats; JSON keyed by the column headers for code.
• Hidden rows, footnote markers and buttons are left out.

Download .xlsx (Pro)
• A real Excel file: bold, frozen header, sized columns.
• Numbers become numbers you can sum and sort (1,250 → 1250, 12.5% → 12.5%), read the way the
  page's language writes them. Codes with leading zeros, long IDs, prices and dates stay exactly
  as on the page.

Column picker (Pro)
• Choose which columns you need and put them in your order before copying or downloading. The
  preview follows as you go.

Merge tables (Pro)
• Add tables from one page or many to a basket, then export them together: stacked into one
  table with columns lined up by name, optionally with source columns, or one sheet per table.

Private by design: everything runs on your computer. No account, no server, no analytics, no
network requests. Pages are read only when you use Table Copy on them; settings and the basket
stay in your browser.

Free vs Pro: copying tables in every format, the table list and the shortcut are free. Download
.xlsx, the column picker and merging tables are Pro ($2.99 once). During early access, Pro is
free for everyone.

## Single purpose

Export HTML tables from web pages as data: copy them as CSV, TSV, Markdown or JSON, or download
them as .xlsx, optionally with chosen columns or merged with other tables the user collected.

## Permission justifications

- **activeTab**: read the tables of the current tab only after the user uses the context menu or
  opens the popup there.
- **scripting**: inject the table reader and the confirmation message into that tab on demand.
  No content scripts run on pages otherwise.
- **contextMenus**: the "Table Copy" items (copy as CSV / TSV / Markdown / JSON, add to basket)
  on selected text.
- **storage**: the user's settings and the basket of tables the user chose to collect, stored
  locally.
- **offscreen**: a hidden extension page that writes the table to the clipboard for the
  background service worker (which has no clipboard access of its own).
- **clipboardWrite**: put the converted table on the clipboard.

No host permissions, no downloads permission (the popup saves .xlsx files with a download link).

## Data usage (privacy practices form)

- Collects no user data. Tables are processed locally only when the user copies or collects them.
- The basket (tables the user adds, with their page title and address) is stored in
  `chrome.storage.local` on the user's device and never transmitted. The user can remove items or
  clear it at any time.
- No remote code; all code and assets (including the fflate zip library) are in the package.

## Remote code

No. All code, fonts, icons and the fflate library are in the package.

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/table-copy/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

Generated by `node scripts/store-assets.mjs` from the e2e screenshots (fixture pages are served
as `shop.example.com`, `store.example.net` and `stats.example.org`, so no test address shows).
`toast-csv.png` is left out on purpose: its fixture table contains a formula-injection test row.

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | The popup: every table on the page with previews |
| `assets/screenshot-2.png` | 1280×800 | CSV delimiter and .xlsx number settings |
| `assets/screenshot-3.png` | 1280×800 | Column picker (Pro) |
| `assets/screenshot-4.png` | 1280×800 | Basket with tables from two sites (Pro) |
| `assets/screenshot-5.png` | 1280×800 | Dark mode, privacy |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

- [ ] Load `release/table-copy-<version>.zip` unpacked in normal Chrome.
- [ ] Alt+T and right-click → Table Copy on Wikipedia (a table with merged headers), a sortable
      data table on a stats site and a page with a strict CSP (GitHub).
- [ ] Paste TSV into Google Sheets and desktop Excel: cells, not one column.
- [ ] Open a downloaded .xlsx in Excel, Google Sheets and Numbers: numbers sum, header frozen,
      leading-zero codes kept. (Only checked by parsing the file so far: **unverified in Excel**.)
- [ ] CSV with semicolons opens correctly in Excel with a Ukrainian or German locale.
- [ ] macOS: Alt+T (Option+T) is assigned in `chrome://extensions/shortcuts`.

## Notes for the reviewer

Open any page with an HTML table (for example a Wikipedia article) and click the toolbar button
or press Alt+T: every table is listed with a preview and CSV / TSV / Markdown / JSON buttons.
Right-click inside a table → Table Copy for the same from the page. No account or login is
needed.

## Distinct from Universal Copy (store duplicate-functionality policy)

Table Copy is about tables as data: its primary features are the table list, .xlsx files with real
numbers, the column picker and merging tables across pages. It doesn't copy ordinary selections
as text, Markdown or HTML. Different name, icon (green grid), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
