/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

declare module '*.css' {
  const css: string;
  export default css;
}
