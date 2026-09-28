/** Fixture pages imported as text (Vite's `?raw`), for DOM tests on real page markup. */
declare module '*?raw' {
  const content: string;
  export default content;
}
