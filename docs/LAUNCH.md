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

## Per extension: before submitting

- [ ] `npm run check` and `npm run test:e2e` green; `dist/` rebuilt from a clean tree.
- [ ] **Manually test the live sites/APIs** the extension depends on (the build sandbox couldn't):
      Chat Exporter / AI Chat Search on chatgpt.com and claude.ai; CryptoSignal on Binance/Coinbase;
      Polymarket on real market pages; Pastebot/Universal Copy on GitHub, Stack Overflow, YouTube.
- [ ] Version bumped in `package.json` (the build copies it into the manifest).
- [ ] Zip the **contents** of `dist/` (not the folder itself).
- [ ] Listing text from the extension's `store/listing.md` (create one if missing): name (≤ 75
      chars), short description (≤ 132 chars), detailed description, category, language.
- [ ] Graphics: 128×128 icon (already in `static/icons/`), **1–5 screenshots at 1280×800 or
      640×400** (pad the README screenshots onto a canvas of that size), small promo tile 440×280.
- [ ] **Privacy practices tab**: single purpose statement, a justification for **every** permission
      (copy from the README's permission table), data usage disclosures (all "not collected" except
      where noted), and the privacy policy URL.
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
