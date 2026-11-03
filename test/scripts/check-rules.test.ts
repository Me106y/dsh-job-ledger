import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RULES, formatViolation, scanText, scanTree } from '../../scripts/check-rules.ts'

/** @param file repo-relative path @param code one or more lines @returns rule ids that fired */
function fired(file: string, code: string): string[] {
  return scanText(file, code).map((violation) => violation.rule)
}

test('a synthetic DOM click is caught with the reason the platform can tell', () => {
  assert.deepEqual(fired('src/cdp/apply.ts', "await page.evaluate(() => button.click())"), [
    'no-dom-click',
  ])
})

test('the real click mechanism is not flagged', () => {
  assert.deepEqual(
    fired('src/cdp/apply.ts', "await session.call('Input.dispatchMouseEvent', { type: 'mousePressed' })"),
    [],
  )
})

test('a request we issue to the platform is caught', () => {
  assert.deepEqual(
    fired('src/cdp/resume.ts', "const res = await fetch('https://www.zhipin.com/wapi/zpgeek/resume/status.json')"),
    ['no-request-replay'],
  )
})

test('the local debug-port probe is allowed', () => {
  assert.deepEqual(
    fired('src/cdp/chrome.ts', "await fetch(`http://127.0.0.1:${String(port)}/json/version`)"),
    [],
  )
})

test('ledger importing run or cdp is caught', () => {
  assert.deepEqual(fired('src/ledger/project.ts', "import { transition } from '../run/machine.ts'"), [
    'ledger-is-a-leaf',
  ])
  assert.deepEqual(fired('src/ledger/project.ts', "import type { Profile } from '../shared/profile.ts'"), [])
})

test('a client importing host code is caught', () => {
  assert.deepEqual(fired('src/client/queue.tsx', "import { queueRows } from '../ledger/queue.ts'"), [
    'client-boundary',
  ])
  assert.deepEqual(fired('src/client/queue.tsx', "import type { Api } from '../api/contract.ts'"), [])
})

test('a second writer to the ledger is caught anywhere but the store', () => {
  assert.deepEqual(fired('src/discover/ingest.ts', "appendFileSync(path, line)"), ['single-writer'])
  assert.deepEqual(fired('src/discover/ingest.ts', "writeFileSync(eventsPath, line)"), ['single-writer'])
  assert.deepEqual(fired('src/ledger/store.ts', "writeSync(fd, line)"), [])
})

test('writing a standalone artifact is not a second ledger writer', () => {
  // Evidence screenshots are their own files; the rule is about the append-only log.
  assert.deepEqual(
    fired('src/run/evidence.ts', "writeFileSync(join(directory, `${appId}.png`), png, { mode: 0o600 })"),
    [],
  )
})

test('native and heavyweight dependencies are caught', () => {
  assert.deepEqual(fired('src/ledger/store.ts', "import Database from 'better-sqlite3'"), [
    'no-native-dependency',
  ])
})

test('console output is caught; the context logger is fine', () => {
  assert.deepEqual(fired('src/index.ts', "console.log('hi')"), ['no-console'])
  assert.deepEqual(fired('src/index.ts', 'ctx.logger.info("hi")'), [])
})

test('a rule never fires on the comment that explains it', () => {
  const code = [
    '// 点击走 Input.dispatchMouseEvent；element.click() 会产生不可信事件',
    ' * 禁止 appendFileSync(path, line)',
    '/* fetch("https://www.zhipin.com/wapi/x") */',
  ].join('\n')
  assert.deepEqual(scanText('src/cdp/apply.ts', code), [])
})

test('a clean file has no violations', () => {
  const code = [
    "import { readFileSync } from 'node:fs'",
    "import type { Job } from './events.ts'",
    'export function load(path: string): string {',
    '  return readFileSync(path, "utf8")',
    '}',
  ].join('\n')
  assert.deepEqual(scanText('src/ledger/store.ts', code), [])
})

test('every violation carries the three answers a fixer needs', () => {
  const [violation] = scanText('src/cdp/apply.ts', 'button.click()')
  assert.ok(violation !== undefined)
  const text = formatViolation(violation)
  assert.match(text, /^src\/cdp\/apply\.ts:1 {2}\[no-dom-click\]/)
  assert.match(text, /为什么：/)
  assert.match(text, /怎么改：/)
})

test('scanTree walks nested directories and reports repo-relative paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rules-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src', 'cdp'), { recursive: true })
  writeFileSync(join(root, 'src', 'cdp', 'bad.ts'), 'button.click()\n')
  writeFileSync(join(root, 'src', 'fine.ts'), 'const x = 1\n')

  const violations = scanTree(root)

  assert.equal(violations.length, 1)
  assert.equal(violations[0]?.file, 'src/cdp/bad.ts')
})

test('the rule list is not empty and every rule has a fix', () => {
  assert.ok(RULES.length >= 7)
  for (const rule of RULES) {
    assert.ok(rule.fix.length > 0, `${rule.id} must say how to fix it`)
    assert.ok(rule.why.length > 0, `${rule.id} must say why it matters`)
  }
})
