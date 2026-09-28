# Chrome Web Store listing: Snippets

Everything to paste into the Developer Dashboard. Graphics are in [`assets/`](assets)
(regenerate with `node scripts/store-assets.mjs`), the package with `npm run package`
(`release/text-expander-<version>.zip`).

> **Name risk (unverified).** "Snippets" and "Text Expander" are generic words, and the build
> sandbox couldn't search the Chrome Web Store. Expect other extensions with "Snippets" in the
> name, and note that **TextExpander** is an established commercial product: the manifest uses
> "Text Expander" (two words) only as a description after the dash. Search the store before the
> first upload and pick a distinct brand if needed: change `name`, `short_name` and
> `action.default_title` in `static/manifest.json`, then re-run `node scripts/store-assets.mjs`
> and `npm run package`.

## Name

Snippets – Text Expander

## Short description (manifest `description`, ≤ 132 characters)

Type ;sig anywhere and it expands into your saved text, or type ; and pick from suggestions. Private: nothing leaves your browser.

## Category and language

Productivity → Tools (alternative: Workflow & Planning). Language: English.

## Detailed description

Type less. Your saved text is one ; away.

Snippets turns short abbreviations into text you type again and again: your signature, an
address, a canned reply, a meeting request, today's date. Type ;sig in any text field and it
becomes your signature. Or just type ; and pick the snippet you need from a list under the
caret.

Suggestions under the caret
• Type ; (or whatever symbol your abbreviations start with) and your snippets appear right
  under the caret, most used first.
• Keep typing to filter: ;me finds ;meet, and ;thank finds the snippet labelled "Thanks".
• ↑/↓ choose, Tab or Enter inserts, Esc closes. A click works too. Nothing is taken over when
  the list isn't showing: Enter still sends, Tab still moves on.
• Turn it off in the manager if you only want expansion.

Expands anywhere you type
• Inputs, text areas and rich editors (contenteditable), inside iframes and web components.
• The page's undo keeps working, and Backspace right after an expansion brings back what you
  typed.
• Expand as you type, or only after Space, Tab or Enter.
• Pause it on any site with one switch in the toolbar popup.

Variables
• {date}, {time}, {weekday} and your own formats like {date:YYYY-MM-DD}.
• {cursor} puts the caret where you want to keep typing.
• {clipboard} drops in what you copied (asks for clipboard access once, only if you use it).

Fill-in fields and dropdowns (Pro)
• {input:Name} asks for a value, {choice:Day=Tuesday|Wednesday|Thursday} offers a dropdown.
  A small form opens next to the caret; Enter inserts.

Stay organised
• A manager with search, tags (Pro), import and export.
• Usage stats: see how often each snippet is used and when it was last used; sort by most
  used, A–Z or recent. The popup lists your most used snippets first; click one to copy it.

Private by design: Snippets runs entirely in your browser. No account, no server, no analytics,
no network requests. Your snippets and usage counts stay in this browser; export them to a file
whenever you like.

Free vs Pro: expansion, suggestions, all variables including {clipboard}, usage stats, the
popup, per-site pause and import/export are free, for up to 20 snippets. Unlimited snippets,
tags and fill-in fields/dropdowns are Pro ($3.99 once). During early access, Pro is free for
everyone.

## Single purpose

Insert text the user saved ("snippets") into text fields on web pages when the user types the
snippet's abbreviation or picks it from a list of matching snippets, with variables such as the
date, the clipboard and fill-in values, and a manager and toolbar popup to create, organise and
copy snippets.

## Permission justifications

- **Content script on all sites (`<all_urls>`, all frames, `match_about_blank`)**: a text
  expander has to notice what the user types wherever they type it, in any text field on any
  site, including editors inside iframes. Host permissions can't be limited to a list of sites
  without breaking the core function, and `activeTab` only applies after a click, not while
  typing. What the script does per keystroke: if the typed character can't end any of the
  user's abbreviations (a Set lookup), it stops. Otherwise it reads only the text before the
  caret up to the length of the longest abbreviation (plus one character) and looks it up.
  For suggestions it reads the current word before the caret (at most 42 characters) only after
  a character that an abbreviation starts with (e.g. `;`), until the word ends. It never runs
  in password, one-time-code or credit-card fields, keeps nothing and sends nothing. There are
  no host permissions.
- **storage**: the user's snippets, settings and usage counts, stored locally.
- **activeTab**: read the current tab's address when the user opens the toolbar popup, to show
  and toggle "Expanding on this site" for that site.
- **clipboardRead (optional)**: requested only when the user saves a snippet containing
  `{clipboard}` (or clicks "Allow clipboard access"). Used only at the moment such a snippet is
  inserted or copied, to put the clipboard's plain text into it. Never read otherwise, never
  stored. The user can remove it in the manager.

## Remote code

No. All code, fonts and icons are in the package.

## Data usage (privacy practices form)

- Nothing is collected: no data leaves the user's device. Typed text is checked locally for
  abbreviations and never stored; snippets, settings and per-snippet usage counts are kept in
  `chrome.storage.local`; the clipboard is read only for `{clipboard}` at insert time.
- Certify all three: not sold to third parties, not used for purposes unrelated to the single
  purpose, not used to determine creditworthiness.
- If the form insists that data processed only on the device counts, tick **Website content**
  (text typed in fields, checked locally) and say "processed locally, never stored or
  transmitted".

## Privacy policy URL

`https://github.com/ChonkaWork/YearPercentageBot/blob/main/text-expander/PRIVACY.md`
(works once this branch is merged into `main`; the repository is public).

## Graphics

Generated by `node scripts/store-assets.mjs` from the e2e screenshots. The fixture pages are
served as `mail.example.com` and `forms.example.com` (no test address shows); the sample
library and its usage counts are made up for the pictures.

| File | Size | Shows |
| --- | --- | --- |
| `assets/screenshot-1.png` | 1280×800 | Suggestions under the caret while writing an email (hero) |
| `assets/screenshot-2.png` | 1280×800 | `;meet` and `;sig` expanded in the email |
| `assets/screenshot-3.png` | 1280×800 | The fill-in form with a text field and a dropdown (Pro) |
| `assets/screenshot-4.png` | 1280×800 | The manager: usage stats, sort by most used, variables as chips |
| `assets/screenshot-5.png` | 1280×800 | The toolbar popup in dark mode: most used first, private by design |
| `assets/promo-small-440x280.png` | 440×280 | Small promo tile |
| `assets/marquee-1400x560.png` | 1400×560 | Marquee (optional, used only if featured) |
| `static/icons/icon128.png` | 128×128 | Store icon |

## Check by hand before submitting

The e2e test covers every flow on local fixture pages; these need a real browser and real sites
(all **unverified** so far):

- [ ] Load `release/text-expander-<version>.zip` unpacked (unzip, Load unpacked) in normal Chrome.
- [ ] Gmail compose, Outlook web, Google Search, a GitHub comment, a Slack or Discord message
      box, LinkedIn messaging, a WordPress/TinyMCE editor, Notion: `;sig` expands, `;` lists
      suggestions under the caret, Enter/Tab insert, and Enter still sends when the list is closed.
- [ ] The list's position next to the caret on those sites, including near the bottom of the
      window (it opens above the caret there).
- [ ] `{clipboard}`: save a snippet with it, accept Chrome's prompt ("Read data you copy and
      paste"), then expand it on the sites above. Remove access from the manager and check it
      inserts nothing. (Automation can't click Chrome's prompt.)
- [ ] Sites with their own `;` or `/` shortcuts (Slack slash commands, Notion's `/` menu): make
      sure the two lists don't fight.
- [ ] macOS: typing, ⌘Z, and Esc in the real toolbar popup.

## Notes for the reviewer

After install, six starter snippets exist. Click into any text field on a normal web page and
type `;ty`: it becomes "Thank you so much for your help!". Type `;` and a list of snippets
appears under the caret; press Enter to insert the first. The toolbar button opens the popup
(click a snippet to copy it); the gear opens the manager. `{clipboard}` is optional: Chrome asks
for clipboard access only when a snippet containing it is saved. No account or login is needed.
