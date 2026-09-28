import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __E2E__: 'false' },
  plugins: [
    {
      // Same as esbuild's `.svg: text` loader: Bootstrap Icons are imported as SVG source.
      name: 'svg-as-text',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.svg')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        return null;
      },
    },
  ],
});
