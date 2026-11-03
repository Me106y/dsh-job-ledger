/**
 * Machine-check the rules that must not depend on a reviewer remembering them.
 *
 * `AGENTS.md` says a rule's enforcement order is: a check that runs > a line in a document > a
 * verbal agreement. The rules below are the ones whose violation is unrecoverable (a replayed
 * request, a second writer to the ledger, a false duplicate), so they get a check.
 *
 * Every message answers three questions, because the person who sees it is usually an agent that
 * must fix it without asking: what is wrong, why it matters, and what to write instead.
 *
 * Run: `pnpm lint:rules` (wired into `pnpm check` and CI).
 *
 * @module dsh-job-ledger/scripts/check-rules
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One rule violation, reported with the fix rather than just the fault. */
export interface Violation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly problem: string
  readonly why: string
  readonly fix: string
}

/** One check. `applies` limits it to a subtree; `match` sees one code line at a time. */
export interface Rule {
  readonly id: string
  readonly applies: (file: string) => boolean
  readonly match: (line: string, file: string) => boolean
  readonly problem: string
  readonly why: string
  readonly fix: string
}

/** Repository-relative, forward-slashed, so messages are stable across platforms. */
function normalize(path: string): string {
  return path.split(sep).join('/')
}

/** @param file repo-relative path @returns whether it is under `dir/` */
function under(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`)
}

/**
 * Strip comments so a rule about code does not fire on the sentence explaining the rule.
 *
 * @param raw one source line
 * @returns the code part, trimmed
 */
function codeOf(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return ''
  }
  return stripInlineComment(trimmed).trim()
}

/**
 * Remove a trailing `//` comment without eating the one inside `https://`.
 *
 * @param line one code line, already trimmed
 * @returns the code part
 */
function stripInlineComment(line: string): string {
  let index = line.indexOf('//')
  while (index !== -1) {
    if (line[index - 1] !== ':') return line.slice(0, index)
    index = line.indexOf('//', index + 2)
  }
  return line
}

/** Every rule this repo treats as non-negotiable. */
export const RULES: readonly Rule[] = [
  {
    id: 'no-dom-click',
    applies: (file) => under(file, 'src'),
    match: (line) => /\.click\s*\(/.test(line),
    problem: 'synthetic DOM click',
    why: 'element.click() produces an isTrusted=false event, which the platform can tell apart from a real click.',
    fix: 'click through Input.dispatchMouseEvent at the element centre, or route the action through the run layer.',
  },
  {
    id: 'no-request-replay',
    applies: (file) => under(file, 'src'),
    match: (line) => /\b(fetch|request)\s*\(/.test(line) && /zhipin\.com/.test(line),
    problem: 'request issued to the platform by us',
    why: 'the compliance line (PRD §5.1, constraint C3) is that every byte comes from a request the page made itself.',
    fix: 'wait for the page to request it (cdp/network.ts captureResponse) instead of calling the endpoint.',
  },
  {
    id: 'ledger-is-a-leaf',
    applies: (file) => under(file, 'src/ledger'),
    match: (line) => /from '\.\.\/(run|cdp|tools|runtime)\//.test(line),
    problem: 'ledger imports a layer above it',
    why: 'TECH §4 forbids ledger depending on run or cdp: the log must be interpretable without the browser or a run.',
    fix: 'keep the fact in the ledger and interpret it in the layer that owns it (run derives run state).',
  },
  {
    id: 'client-boundary',
    applies: (file) => under(file, 'src/client'),
    match: (line) => /from '\.\.\/(cdp|ledger|run|dedupe|filter|discover|resume|tools|runtime)\//.test(line),
    problem: 'panel imports host code',
    why: 'the client runs in the browser bundle; importing host modules ships filesystem and CDP code to the page.',
    fix: "import from '../api/contract.ts' (type-only) or '../shared/errors.ts'.",
  },
  {
    id: 'single-writer',
    applies: (file) => under(file, 'src') && file !== 'src/ledger/store.ts',
    // Append-style writes are always the ledger. `writeFileSync` is how standalone artifacts
    // (evidence screenshots) are written, so it only counts when the target is the log itself.
    match: (line) =>
      /\b(appendFileSync|createWriteStream|writeSync)\s*\(/.test(line) ||
      /\bwriteFileSync\s*\(.*(events|jsonl)/.test(line),
    problem: 'a second writer to the ledger',
    why: 'TECH §6.2 requires one writer; a second descriptor is how two orders of events become possible.',
    fix: 'append through the Ledger instance (ledger.append) instead of touching the log file.',
  },
  {
    id: 'no-native-dependency',
    applies: (file) => under(file, 'src'),
    match: (line) => /from '(better-sqlite3|sqlite3|playwright|puppeteer|node:sqlite)'/.test(line),
    problem: 'native or heavyweight dependency',
    why: 'the plugin promises `dsh plugin add` with no build step (PRD §7); anything compiled breaks that.',
    fix: 'use Node built-ins (node:fs, node:crypto, global WebSocket) or a pure-JS package.',
  },
  {
    id: 'no-console',
    applies: (file) => under(file, 'src'),
    match: (line) => /^\s*console\.(log|error|warn|debug|info)\s*\(/.test(line),
    problem: 'console output instead of the context logger',
    why: 'the host captures ctx.logger; console output bypasses the log level and can leak resume data.',
    fix: 'inject the cordis context and use ctx.logger.',
  },
]

/**
 * Check one file.
 *
 * @param file repo-relative path
 * @param text file contents
 * @returns violations, in line order
 */
export function scanText(file: string, text: string): Violation[] {
  const violations: Violation[] = []
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const code = codeOf(lines[index] ?? '')
    if (code === '') continue
    for (const rule of RULES) {
      if (!rule.applies(file) || !rule.match(code, file)) continue
      violations.push({
        file,
        line: index + 1,
        rule: rule.id,
        problem: rule.problem,
        why: rule.why,
        fix: rule.fix,
      })
    }
  }

  return violations
}

/** @param dir directory @returns every `.ts`/`.tsx` file below it */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path)
  }
  return found
}

/**
 * Scan a tree.
 *
 * @param root repository root
 * @param srcDir source directory relative to the root
 * @returns every violation found
 */
export function scanTree(root: string, srcDir = 'src'): Violation[] {
  const violations: Violation[] = []
  for (const path of sourceFiles(join(root, srcDir))) {
    const file = normalize(relative(root, path))
    violations.push(...scanText(file, readFileSync(path, 'utf8')))
  }
  return violations
}

/**
 * Render a violation the way the author needs to read it.
 *
 * @param violation one finding
 * @returns a multi-line block
 */
export function formatViolation(violation: Violation): string {
  return [
    `${violation.file}:${String(violation.line)}  [${violation.rule}] ${violation.problem}`,
    `  为什么：${violation.why}`,
    `  怎么改：${violation.fix}`,
  ].join('\n')
}

/**
 * CLI entry.
 *
 * @param argv process arguments
 * @returns exit code
 */
export function main(argv: readonly string[]): number {
  const root = argv[2] ?? process.cwd()
  const srcDir = argv[3] ?? 'src'
  const violations = scanTree(root, srcDir)

  if (violations.length === 0) {
    console.log(`rules ok: ${String(RULES.length)} checks over ${normalize(srcDir)}`)
    return 0
  }

  for (const violation of violations) console.error(formatViolation(violation))
  console.error(`\n${String(violations.length)} violation(s). Rules are not negotiable; see AGENTS.md.`)
  return 1
}

// Run only when executed directly, so tests can import the module without side effects.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exit(main(process.argv))
}
