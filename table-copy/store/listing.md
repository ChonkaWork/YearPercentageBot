# Chrome Web Store listing: Table Copy

## Name

Table Copy: tables to CSV, XLSX, Markdown, JSON

(Short name in the manifest: Table Copy.)

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

## Screenshots (1280×800, from `screenshots/`)

1. `popup-light.png`: every table on a page with previews and copy buttons.
2. `toast-csv.png`: a table copied as CSV from the context menu (already 1280×800).
3. `popup-columns.png`: the column picker choosing and reordering columns.
4. `popup-basket.png`: tables from two pages in the basket, ready to export as .xlsx.
5. `options-light.png`: CSV delimiter, numbers in .xlsx, About Pro.

Popup screenshots need to be placed on a 1280×800 canvas (brand green `#2b8a3e` or a light grey
background) before upload. Dark variants: `popup-dark.png`, `popup-columns-dark.png`,
`popup-basket-dark.png`, `options-dark.png`.

## Distinct from Universal Copy (store duplicate-functionality policy)

Table Copy is about tables as data: its primary features are the table list, .xlsx files with real
numbers, the column picker and merging tables across pages. It doesn't copy ordinary selections
as text, Markdown or HTML. Different name, icon (green grid), screenshots and description. See
`docs/MONETIZATION.md`: publish either Universal Copy or the focused extensions first.
