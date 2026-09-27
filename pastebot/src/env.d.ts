/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Sass compiled to a CSS string (only imported for shadow-DOM styles). */
declare module '*.scss' {
  const css: string;
  export default css;
}

/** SVG file contents as text (Bootstrap Icons). */
declare module '*.svg' {
  const svg: string;
  export default svg;
}
