import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../../src/config.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import {
  DISCOVER_TOOL_NAME,
  discoverForModel,
  renderDiscoverResult,
} from '../../src/tools/discover.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const search = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/search.json', import.meta.url)), 'utf8'),
) as unknown

const CONFIG = resolveConfig({ dataDir: '/tmp/job-ledger-discover-test' })

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-discover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @param browser fake page @returns a provider that hands it out */
function provider(browser: ReplayBrowser): ReaderProvider {
  return { reader: async () => browser }
}

test('one discovery call reads, judges, and records the whole page', async (t) => {
  const ledger = tempLedger(t)

  const result = await discoverForModel(provider(new ReplayBrowser({ search })), ledger, CONFIG.profile, {
    now: Date.parse('2026-11-03T00:00:00.000Z'),
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.added, 1)
  assert.equal(result.duplicates, 1)
  assert.equal(result.filtered, 1)
  assert.equal(result.invalid, 1)
  assert.equal(result.decisions.length, 3)
  // Only new and filtered postings are recorded; the duplicate is counted, not stored.
  assert.equal(ledger.projection.jobs.size, 2)
})

test('the limit caps how many cards are judged', async (t) => {
  const ledger = tempLedger(t)

  const result = await discoverForModel(provider(new ReplayBrowser({ search })), ledger, CONFIG.profile, {
    limit: 1,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.decisions.length, 1)
  assert.equal(ledger.projection.jobs.size, 1)
})

test('discovering twice adds nothing the second time', async (t) => {
  const ledger = tempLedger(t)
  const browser = new ReplayBrowser({ search })

  await discoverForModel(provider(browser), ledger, CONFIG.profile)
  const second = await discoverForModel(provider(browser), ledger, CONFIG.profile)

  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.added, 0)
  assert.equal(second.duplicates, 3)
  assert.equal(ledger.projection.jobs.size, 2)
})

test('a failed read writes nothing at all', async (t) => {
  const ledger = tempLedger(t)
  const browser = new ReplayBrowser({ search })
  browser.url = 'https://www.zhipin.com/web/user/?ka=header-login'

  const result = await discoverForModel(provider(browser), ledger, CONFIG.profile)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_LOGIN_REQUIRED')
  assert.equal(ledger.projection.jobs.size, 0)
})

test('the rendered line carries every count', () => {
  assert.equal(
    renderDiscoverResult({
      ok: true,
      source: 'search',
      added: 1,
      duplicates: 2,
      filtered: 3,
      suspects: 4,
      invalid: 5,
      decisions: [],
    }),
    '新增 1 / 判重 2 / 过滤 3 / 疑似 4 / 无法识别 5',
  )
  assert.equal(
    renderDiscoverResult({ ok: false, code: 'E_LOGIN_REQUIRED', message: '需要登录' }),
    '[E_LOGIN_REQUIRED] 需要登录',
  )
})

test('the tool name is namespaced', () => {
  assert.equal(DISCOVER_TOOL_NAME, 'job_ledger_discover')
})
