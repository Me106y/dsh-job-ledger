import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import {
  BACKFILL_TOOL_NAME,
  backfillForModel,
  renderBackfillResult,
} from '../../src/tools/backfill.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-backfill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @param browser fake page @returns a provider */
function provider(browser: ReplayBrowser): ReaderProvider {
  return { reader: async () => browser }
}

test('the first run imports the platform history as backfill', async (t) => {
  const ledger = tempLedger(t)

  const result = await backfillForModel(provider(new ReplayBrowser({ deliver })), ledger, { now: NOW })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.backfilled, 3)
  assert.equal(result.matched, 0)
  // The tool never claims a complete history.
  assert.equal(result.partial, true)

  const apps = [...ledger.projection.apps.values()]
  assert.equal(apps.length, 3)
  assert.ok(apps.every((app) => app.source === 'reconcile-backfill'))
  assert.ok(apps.every((app) => app.resumeId === 'unknown'))
})

test('backfilled applications are excluded from the funnel', async (t) => {
  const ledger = tempLedger(t)
  await backfillForModel(provider(new ReplayBrowser({ deliver })), ledger, { now: NOW })

  const { buildReport } = await import('../../src/report/build.ts')
  const report = buildReport(ledger.projection, NOW)
  assert.equal(report.funnel.applied, 0)
  assert.equal(report.excludedBackfill, 3)
})

test('a second run matches instead of duplicating', async (t) => {
  const ledger = tempLedger(t)
  await backfillForModel(provider(new ReplayBrowser({ deliver })), ledger, { now: NOW })
  const second = await backfillForModel(provider(new ReplayBrowser({ deliver })), ledger, { now: NOW })

  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.backfilled, 0)
  assert.equal(second.matched, 3)
  assert.equal(ledger.projection.apps.size, 3)
})

test('a failed read writes nothing', async (t) => {
  const ledger = tempLedger(t)
  const browser = new ReplayBrowser({ deliver })
  browser.url = 'https://www.zhipin.com/web/user/?login'

  const result = await backfillForModel(provider(browser), ledger, { now: NOW })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_LOGIN_REQUIRED')
  assert.equal(ledger.projection.apps.size, 0)
})

test('the rendered line admits the page limit', () => {
  assert.equal(
    renderBackfillResult({ ok: true, matched: 2, backfilled: 5, partial: true }),
    '回填完成：补记 5 / 已存在 2（只导入了平台最近一页，更早的历史未导入）',
  )
  assert.equal(BACKFILL_TOOL_NAME, 'job_ledger_backfill')
})
