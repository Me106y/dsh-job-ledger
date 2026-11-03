import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import {
  RECONCILE_TOOL_NAME,
  reconcileForModel,
  renderReconcileResult,
} from '../../src/tools/reconcile.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-reconcile-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @param browser fake page @returns a provider that hands it out */
function provider(browser: ReplayBrowser): ReaderProvider {
  return { reader: async () => browser }
}

test('the tool reads the platform list, backfills, and reports partial coverage', async (t) => {
  const ledger = tempLedger(t)

  const result = await reconcileForModel(provider(new ReplayBrowser({ deliver })), ledger, {
    now: NOW,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.backfilled, 3)
  assert.equal(result.matched, 0)
  assert.equal(result.partial, true)
  assert.deepEqual(result.discrepancies, [])
  assert.equal(ledger.projection.apps.size, 3)
})

test('a second run matches instead of duplicating', async (t) => {
  const ledger = tempLedger(t)
  await reconcileForModel(provider(new ReplayBrowser({ deliver })), ledger, { now: NOW })
  const second = await reconcileForModel(provider(new ReplayBrowser({ deliver })), ledger, {
    now: NOW,
  })

  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.backfilled, 0)
  assert.equal(second.matched, 3)
  assert.equal(ledger.projection.apps.size, 3)
})

test('a failed read writes nothing and returns the code', async (t) => {
  const ledger = tempLedger(t)
  const browser = new ReplayBrowser({ deliver })
  browser.url = 'https://www.zhipin.com/web/user/?login'

  const result = await reconcileForModel(provider(browser), ledger, { now: NOW })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_LOGIN_REQUIRED')
  assert.equal(ledger.projection.apps.size, 0)
})

test('the rendered line warns when only part of the history was read', () => {
  assert.equal(
    renderReconcileResult({
      ok: true,
      matched: 4,
      backfilled: 1,
      partial: true,
      discrepancies: [],
      platformOnly: [],
    }),
    '对账完成：匹配 4 / 补记 1 / 差异 0（只核对了平台最近一页，差异可能包含更早的投递）',
  )
  assert.equal(
    renderReconcileResult({ ok: false, code: 'E_BODY_UNAVAILABLE', message: '没能取到页面响应内容' }),
    '[E_BODY_UNAVAILABLE] 没能取到页面响应内容',
  )
})

test('the tool name is namespaced', () => {
  assert.equal(RECONCILE_TOOL_NAME, 'job_ledger_reconcile')
})
