/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Bootstrap Icons, imported as SVG source text. */
declare module '*.svg' {
  const svg: string;
  export default svg;
}

/** Compiled Sass for the in-page picker (a virtual module provided by the build). */
declare module 'virtual:picker-css' {
  const css: string;
  export default css;
}
