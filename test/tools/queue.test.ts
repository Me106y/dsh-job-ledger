import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestJobs } from '../../src/discover/ingest.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { QUEUE_TOOL_NAME, queueForModel, renderQueueResult } from '../../src/tools/queue.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-queue-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

test('the tool returns the same rows the panel would render', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(
    ledger,
    [
      { externalId: 'job_a1', title: '后端工程师', company: '字节跳动', city: '深圳', salaryRaw: '25-35K' },
      { externalId: 'job_a3', title: '销售代表', company: '某贸易公司', city: '深圳' },
    ],
    { now: NOW },
  )

  const result = queueForModel(ledger, { filter: 'new' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.total, 1)
  assert.equal(result.rows[0]?.company, '字节跳动')
  assert.equal(result.rows[0]?.salaryRaw, '25-35K')
})

test('the filter is honoured and the default is new', (t) => {
  const ledger = tempLedger(t)
  assert.equal(queueForModel(ledger).ok, true)
  const result = queueForModel(ledger)
  if (!result.ok) return
  assert.equal(result.filter, 'new')
})

test('an empty queue says why it is empty instead of returning nothing', () => {
  assert.equal(
    renderQueueResult({ ok: true, filter: 'new', total: 0, rows: [] }),
    '没有新岗位：今天发现的都已被判重或过滤。',
  )
  assert.equal(
    renderQueueResult({ ok: true, filter: 'filtered', total: 0, rows: [] }),
    '没有可捞回的岗位。',
  )
  assert.equal(
    renderQueueResult({ ok: true, filter: 'suspect', total: 0, rows: [] }),
    '没有待裁决的疑似重复。',
  )
})

test('rows render as one line each and end with the total', () => {
  const text = renderQueueResult({
    ok: true,
    filter: 'new',
    total: 2,
    rows: [
      {
        jobId: 'j_1',
        title: '后端工程师',
        company: '字节跳动',
        city: '深圳',
        decision: 'new',
        reason: 'new',
        salaryRaw: '25-35K',
        source: 'search',
        firstSeenAt: '2026-11-03T00:00:00.000Z',
      },
      {
        jobId: 'j_2',
        title: '数据工程师',
        company: '美团',
        city: '北京',
        decision: 'new',
        reason: 'new',
        source: 'search',
        firstSeenAt: '2026-11-02T00:00:00.000Z',
      },
    ],
  })

  assert.equal(
    text,
    [
      '1. 字节跳动 · 后端工程师 · 深圳 · 25-35K（new）',
      '2. 美团 · 数据工程师 · 北京（new）',
      '共 2 条，显示 2 条。',
    ].join('\n'),
  )
})

test('a failure renders its code', () => {
  assert.equal(
    renderQueueResult({ ok: false, code: 'E_LEDGER_WRITE', message: '账本写入失败' }),
    '[E_LEDGER_WRITE] 账本写入失败',
  )
})

test('the tool name is namespaced', () => {
  assert.equal(QUEUE_TOOL_NAME, 'job_ledger_queue')
})
