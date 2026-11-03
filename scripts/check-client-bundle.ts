/**
 * Machine-check the *format* of the built client bundle.
 *
 * DSH activates a client plugin by appending a classic `<script>` to the page
 * (`dsh-client-modules`' `defaultLoadBundle`), so `lib/client.js` must be a classic script that
 * registers its factory:
 *
 *     window.__ModuleLoader__.load({ id: "dsh-job-ledger", factory: (require) => { … } })
 *
 * An ESM bundle (`import … from "react"`) is a parse error in that position: the browser throws
 * `SyntaxError: Cannot use import statement outside a module`, registers nothing, and the Web boot
 * reports `dsh-job-ledger: import failed` while every other plugin keeps working. That failure is
 * silent at build time, which is why this check exists: `pnpm build` runs it, so a wrong `format`
 * or a dropped `banner`/`footer` fails the build instead of the page.
 *
 * Run: `node scripts/check-client-bundle.ts` (after a build), or through `pnpm build`.
 *
 * @module dsh-job-ledger/scripts/check-client-bundle
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

/** The registration id a bundle must use: it is how the boot graph files the module. */
export const PACKAGE_NAME = 'dsh-job-ledger'

/** Built client bundle, relative to the repository root (`package.json` exports this path). */
export const BUNDLE_PATH = 'lib/client.js'

/** One format problem, reported with the rule and the fix rather than just the fault. */
export interface Problem {
  readonly rule: string
  readonly problem: string
  readonly fix: string
}

/** What one bundle registered when executed as a classic script. */
interface Registration {
  readonly id?: unknown
  readonly factory?: unknown
}

/**
 * Read a registration out of a bundle by running it the way the page does: as a classic script.
 *
 * Executing only registers the factory — the module body lives inside the factory closure and runs
 * on materialization — so this has no side effects beyond the `window` stub passed in.
 *
 * @param source bundle text
 * @returns the registration, or the parse error that stopped it
 */
function register(source: string): { registration?: Registration; error?: Error } {
  let registration: Registration | undefined
  const stub = { __ModuleLoader__: { load: (value: Registration) => (registration = value) } }
  try {
    runInNewContext(source, { window: stub, console })
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  return registration === undefined ? {} : { registration }
}

/**
 * Check one bundle's text.
 *
 * @param source bundle text
 * @returns every problem found, empty when the bundle is loadable
 */
export function checkBundle(source: string): Problem[] {
  const { registration, error } = register(source)

  if (error !== undefined) {
    return [
      {
        rule: 'classic-script',
        problem: `the bundle does not run as a classic script: ${error.message}`,
        fix:
          'build the client with format: "cjs" and wrap it with banner/intro/footer so it registers ' +
          'window.__ModuleLoader__.load({ id, factory }); an ESM bundle cannot be loaded this way',
      },
    ]
  }

  if (registration === undefined) {
    return [
      {
        rule: 'registers-factory',
        problem: 'the bundle ran but never called window.__ModuleLoader__.load({ id, factory })',
        fix: 'add the banner/footer from tsdown.config.ts so the bundle registers its factory',
      },
    ]
  }

  const problems: Problem[] = []
  if (registration.id !== PACKAGE_NAME) {
    problems.push({
      rule: 'registration-id',
      problem: `the bundle registers ${JSON.stringify(registration.id)}, not "${PACKAGE_NAME}"`,
      fix: 'the registration id must be the package name: the boot graph files the bundle under it',
    })
  }
  if (typeof registration.factory !== 'function') {
    problems.push({
      rule: 'factory-shape',
      problem: 'the registration has no factory function',
      fix: 'export the plugin as CommonJS so the factory returns module.exports with apply/inject',
    })
  }
  return problems
}

/**
 * Render a problem the way the author needs to read it.
 *
 * @param problem one finding
 * @returns a multi-line block
 */
export function formatProblem(problem: Problem): string {
  return [`${BUNDLE_PATH}  [${problem.rule}] ${problem.problem}`, `  怎么改：${problem.fix}`].join(
    '\n',
  )
}

/**
 * CLI entry.
 *
 * @param argv process arguments
 * @returns exit code
 */
export function main(argv: readonly string[]): number {
  const root = argv[2] ?? process.cwd()
  const path = resolve(root, BUNDLE_PATH)
  const problems = checkBundle(readFileSync(path, 'utf8'))

  if (problems.length === 0) {
    console.log(`client bundle ok: ${BUNDLE_PATH} loads as a classic script and registers ${PACKAGE_NAME}`)
    return 0
  }

  for (const problem of problems) console.error(formatProblem(problem))
  console.error('\nThe Web boot would report "import failed"; see docs/TECH-DESIGN.md §3.3.')
  return 1
}

// Run only when executed directly, so tests can import the module without side effects.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exit(main(process.argv))
}
