/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Compiled Sass, imported as a CSS string (see scripts/build.mjs). */
declare module '*.scss' {
  const css: string;
  export default css;
}

/** Bootstrap Icons, imported as SVG source text. */
declare module '*.svg' {
  const svg: string;
  export default svg;
}
