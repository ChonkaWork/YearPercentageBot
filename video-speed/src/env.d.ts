/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Compiled Sass, imported as a CSS string (see scripts/build.mjs). */
declare module '*.scss' {
  const css: string;
  export default css;
}

/** SVG files are bundled as text (Bootstrap Icons). */
declare module '*.svg' {
  const svg: string;
  export default svg;
}

/** Raw file contents (Vite/Vitest), used by unit tests. */
declare module '*?raw' {
  const text: string;
  export default text;
}
