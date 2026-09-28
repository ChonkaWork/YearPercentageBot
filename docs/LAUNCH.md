# Chrome Web Store launch plan

How to get the extensions from this repo into the Chrome Web Store, in what order, and what to
check before each submission. Pricing and the free/Pro split live in
[`MONETIZATION.md`](MONETIZATION.md); product rationale in [`CONCEPTS.md`](CONCEPTS.md).

## One-time setup

1. **Developer account**: register at the Chrome Web Store Developer Dashboard with a Google
   account (one-time registration fee, $5 at the time of writing). Use a dedicated account, not a
   personal one; all 13 listings live under it.
2. **Publisher profile**: display name, contact email, website. A single simple site (even a
   GitHub Pages page) with one section per extension and a **privacy policy** page is enough.
3. **Verify the email** and enable 2-step verification (required for publishing).
4. Decide the **payment provider** before any listing mentions a price (see MONETIZATION.md).
   Until then listings say "Free" and Pro features are free during early access.

## First batch: ready to submit

Prepared for upload (September 2026): listing text, privacy policy, store graphics and a
verified package for each. What is left is yours: the developer account, the hand checks on real
sites listed in each `store/listing.md`, and the **store names** (see below).

| Extension | Listing | Privacy policy | Graphics | Package |
| --- | --- | --- | --- | --- |
| Progress Tab | [`progress-tab/store/listing.md`](../progress-tab/store/listing.md) | [`PRIVACY.md`](../progress-tab/PRIVACY.md) | [`store/assets/`](../progress-tab/store/assets) | `npm run package` |
| Pastebot | [`pastebot/store/listing.md`](../pastebot/store/listing.md) | [`PRIVACY.md`](../pastebot/PRIVACY.md) | [`store/assets/`](../pastebot/store/assets) | `npm run package` |
| Table Copy | [`table-copy/store/listing.md`](../table-copy/store/listing.md) | [`PRIVACY.md`](../table-copy/PRIVACY.md) | [`store/assets/`](../table-copy/store/assets) | `npm run package` |
| Clean Copy | [`clean-copy/store/listing.md`](../clean-copy/store/listing.md) | [`PRIVACY.md`](../clean-copy/PRIVACY.md) | [`store/assets/`](../clean-copy/store/assets) | `npm run package` |

**Names.** A search in September 2026 found name clashes for three of the four: Tapbots sells a
Mac clipboard manager called **Pastebot** (Pastebot 3, July 2026), and the Chrome Web Store
already has extensions called **"Table Copy"** and **"Clean Copy"** doing the same jobs. No
"Progress Tab" was found. Choose distinct names before the first upload; each listing says how
to rename (manifest `name`, then re-run the graphics and the package).

**Privacy policy URLs** point to `PRIVACY.md` on the `main` branch of this public repository
(`https://github.com/ChonkaWork/YearPercentageBot/blob/main/<folder>/PRIVACY.md`), so the
extension branch has to be merged first. GitHub Pages works too if you prefer a plain page.

### Tools in each prepared folder

- `npm run package`: typecheck, unit tests, a fresh production build, then preflight checks and
  `release/<folder>-<version>.zip` (git-ignored). The checks fail the run when the manifest
  differs from `static/manifest.json` (so the e2e build's test permissions can't ship), the
  version doesn't match `package.json`, a file the manifest or an HTML page references is missing,
  an icon isn't a PNG of its declared size, or the build contains source maps, the e2e flag,
  remote scripts or names Chrome reserves (`_*`). The zip is deterministic and is read back and
  compared with `dist/` byte for byte.
- `node scripts/store-assets.mjs`: renders `store/assets/` (five 1280×800 screenshots, the 440×280
  small promo tile, the 1400×560 marquee) from the e2e screenshots and `store/assets.json`
  (captions, which screenshot, crop). The screenshots inside are the real UI, never edited.
- `PRIVACY.md` and `THIRD_PARTY_NOTICES.txt` (licenses of the bundled Bootstrap, Bootstrap Icons
  and fonts, written into `dist/` by the build).

## Per extension: before submitting

- [ ] `npm run check` and `npm run test:e2e` green; `dist/` rebuilt from a clean tree.
- [ ] **Manually test the live sites/APIs** the extension depends on (the build sandbox couldn't):
      Chat Exporter / AI Chat Search on chatgpt.com and claude.ai; CryptoSignal on Binance/Coinbase;
      Polymarket on real market pages; Pastebot/Universal Copy on GitHub, Stack Overflow, YouTube.
- [ ] Version bumped in `package.json` (the build copies it into the manifest).
- [ ] Zip the **contents** of `dist/` (not the folder itself): `npm run package` where it exists.
- [ ] Listing text from the extension's `store/listing.md` (create one if missing): name (≤ 75
      chars), short description (≤ 132 chars), detailed description, category, language.
- [ ] Graphics: 128×128 icon (already in `static/icons/`), **1–5 screenshots at 1280×800 or
      640×400**, small promo tile 440×280 (`node scripts/store-assets.mjs` where it exists; copy
      the script and write a `store/assets.json` for the others).
- [ ] **Privacy practices tab**: single purpose statement, a justification for **every** permission
      (copy from the README's permission table), data usage disclosures (all "not collected" except
      where noted), and the privacy policy URL (`PRIVACY.md` in the folder).
- [ ] Host permissions and `<all_urls>` content scripts trigger in-depth review and longer review
      times (Snippets, Video Speed+). Say exactly why in the justification.
- [ ] Remote code: none. Everything is bundled; say so.
- [ ] Honest claims: no "AI predicts", no accuracy numbers, disclaimers visible (CryptoSignal,
      Polymarket). Consider dropping "AI" from those two names until explanations come from a real
      model, or wire up an LLM behind the existing `AIExplanationService`.

## Release order

Ship one or two a week, watch the numbers, then decide (kill rules in CONCEPTS.md).

1. **Progress Tab** (storage only, fastest review, no live-site risk)
2. **Video Speed+** (huge search volume; `<all_urls>` means a slower review)
3. **Pastebot**
4. **Table Copy** (focused listing; Universal Copy later only if the copy niche shows traction)
5. **Snippets**
6. **YouTube Focus**
7. **Clean Copy**
8. **Chat Exporter** (after live selector check)
9. **Page Watch**
10. **Universal Copy** (only if it stays clearly different from Clean Copy and Table Copy)
11. **AI Chat Search** (after live selector check)
12. **CryptoSignal AI** and **Polymarket AI Analyzer** (after live API checks; finance-adjacent
    listings get extra scrutiny, keep claims conservative)

## After launch: weekly

- Developer Dashboard stats: impressions, page views, installs, uninstalls, weekly users,
  ratings.
- Read every review and support email; log feature requests in the extension's README
  ("Requested") with a count.
- After 30 days apply the kill/keep rules. Kept extensions get Pro switched on
  (`EARLY_ACCESS = false`) once payments are set up.

## Things that get extensions rejected (check before every submission)

- A permission that isn't used or isn't justified.
- A description that promises something the extension doesn't do, or keyword stuffing.
- Two listings from the same developer that do the same thing (spam policy).
- Missing privacy policy when any user data is handled (text the user selects counts).
- Obfuscated code (our builds are unminified JS; CSS minification is fine).
