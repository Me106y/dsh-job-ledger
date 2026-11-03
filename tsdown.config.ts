import { defineConfig } from 'tsdown'

/**
 * Two bundles, one package: the host entry (`src/index.ts` -> `lib/index.js`) and the Web panel
 * (`src/client/index.tsx` -> `lib/client.js`); see docs/TECH-DESIGN.md §3.3.
 *
 * Host output layout is pinned: `package.json` exports `./lib/index.js`, so the build must emit
 * exactly that path with a `.js` extension (the package is `"type": "module"`, so ESM `.js` is
 * correct).
 *
 * The client output layout is pinned too, but the *format* is not free: DSH loads a client bundle by
 * appending a **classic** `<script>` (`dsh-client-modules`' `defaultLoadBundle`), so the file may not
 * contain top-level `import`/`export` — a browser throws
 * `SyntaxError: Cannot use import statement outside a module` and the entry never activates. A client
 * bundle is therefore CommonJS wrapped in the module loader's factory closure:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * which is what `banner` + `intro` + `footer` below produce. React and the DSH client packages stay
 * external and arrive through the `require` the loader hands the factory.
 */
type Options = Parameters<typeof defineConfig>[0]

const host: Options = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  // `pnpm build` clears `lib` once, before either config runs; per-config cleans would race each other.
  clean: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // DSH peer packages resolve from the harness at runtime, never from our bundle.
  deps: { neverBundle: [/^@deepseek-ai\//] },
}

/**
 * The client bundle. React and the DSH client packages are provided by the web app, so they are
 * externalised by name; bundling them would ship a second React into the page, and leaving the bare
 * specifiers for the browser to resolve would fail (there is no import map — the loader's `require`
 * is the only resolver).
 */
const client: Options = {
  // Named entry: the client must land on lib/client.js, the path package.json exports.
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // The client entry publishes no types (`exports["./client"]` is the JS file only); tsdown emits no
  // declaration for a CJS bundle inside a `"type": "module"` package, and declaring it here would lie.
  dts: false,
  clean: false,
  tsconfig: 'tsconfig.client.json',
  deps: {
    neverBundle: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The id must equal the package name: that is how the boot graph files this bundle.
    banner: 'window.__ModuleLoader__.load({ id: "dsh-job-ledger", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, client])
