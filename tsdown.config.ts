import { defineConfig } from 'tsdown'

/**
 * Host entry only for now. The client entry (`src/client/index.tsx` -> `lib/client.js`) is added when
 * the panel work starts; see docs/TECH-DESIGN.md §3.3.
 *
 * Output layout is pinned: `package.json` exports `./lib/index.js`, so the build must emit exactly
 * that path with a `.js` extension (the package is `"type": "module"`, so ESM `.js` is correct).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // DSH peer packages resolve from the harness at runtime, never from our bundle.
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
