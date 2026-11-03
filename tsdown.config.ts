import { defineConfig } from 'tsdown'

/**
 * Host entry only for now. The client entry (`src/client/index.tsx` -> `lib/client.js`) is added when
 * the panel work starts; see docs/TECH-DESIGN.md §3.3.
 *
 * Output layout is pinned: `package.json` exports `./lib/index.js`, so the build must emit exactly
 * that path with a `.js` extension (the package is `"type": "module"`, so ESM `.js` is correct).
 */
type Options = Parameters<typeof defineConfig>[0]

const host: Options = {
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
}

/**
 * The client bundle. React and the DSH client packages are provided by the web app, so they are
 * externalised by name; bundling them would ship a second React into the page (TECH §3.1).
 */
const client: Options = {
  // Named entry: the client must land on lib/client.js, the path package.json exports.
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'browser' as const,
  target: 'es2020',
  dts: true,
  clean: false,
  tsconfig: 'tsconfig.client.json',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ],
}

export default defineConfig([host, client])
