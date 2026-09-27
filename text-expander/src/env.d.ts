/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Bootstrap Icons, imported as SVG source text (esbuild `text` loader). */
declare module '*.svg' {
  const svg: string;
  export default svg;
}

/** A Sass file compiled to CSS text, with `:root` rewritten to `:host` for shadow roots. */
declare module '*.scss?inline' {
  const css: string;
  export default css;
}
