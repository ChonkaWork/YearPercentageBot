/** Vite's `?raw` imports: the file's contents as a string (used to load e2e fixture pages). */
declare module '*?raw' {
  const content: string;
  export default content;
}

/** Just enough of node:zlib for the zip tests (an independent deflate/CRC), without @types/node. */
declare module 'node:zlib' {
  export function crc32(data: Uint8Array): number;
  export function deflateRawSync(data: Uint8Array): Uint8Array;
  export function inflateRawSync(data: Uint8Array): Uint8Array;
}

/** Just enough of node:fs to check the import engine's sources (see test/import.test.ts). */
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
  export function readdirSync(path: URL | string): string[];
}
