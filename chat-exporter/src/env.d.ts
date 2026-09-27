/** Replaced at build time. True only in the e2e test build. */
declare const __E2E__: boolean;

/** Sass imported from TypeScript is compiled to a CSS string for a shadow root (see scripts/build.mjs). */
declare module '*.scss' {
  const css: string;
  export default css;
}

/** Bootstrap Icons are turned into element descriptors at build time (see scripts/build.mjs). */
declare module 'bootstrap-icons/icons/*.svg' {
  const icon: import('./ui/icons').IconData;
  export default icon;
}
