/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Bootstrap Icons, imported as SVG text (esbuild `text` loader). */
declare module '*.svg' {
  const svg: string;
  export default svg;
}
