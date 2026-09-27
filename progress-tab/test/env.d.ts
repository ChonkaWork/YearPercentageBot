// Just enough of Node for the tests, without pulling in @types/node.

declare const process: { env: Record<string, string | undefined> };

declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}
