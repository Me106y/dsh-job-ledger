import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../../src/ledger/store.ts'
import { reportForModel, renderReportResult } from '../../src/tools/report.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns an open ledger and its directory */
function setup(t: { after(fn: () => void): void }): { ledger: Ledger; dataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return { ledger, dataDir: dir }
}

test('an empty ledger still produces a readable report', (t) => {
  const { ledger } = setup(t)
  const result = reportForModel(ledger, { now: NOW })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.markdown, /## 漏斗/)
  assert.match(result.markdown, /## 来源/)
  assert.match(result.markdown, /## 周趋势/)
  assert.equal(result.report.funnel.applied, 0)
  assert.match(result.report.conclusion, /还没有可统计的投递/)
})

test('the report counts applications and quotes the conclusion', (t) => {
  const { ledger } = setup(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })

  const result = reportForModel(ledger, { now: NOW })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.report.funnel.applied, 1)
  assert.match(result.markdown, /\| 投递 \| 1 \| 100\.0% \|/)
})

test('save writes snapshot.md private, next to the ledger', (t) => {
  const { ledger, dataDir } = setup(t)

  const result = reportForModel(ledger, { now: NOW, save: true, dataDir })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.savedTo, join(dataDir, 'snapshot.md'))
  const written = readFileSync(join(dataDir, 'snapshot.md'), 'utf8')
  assert.equal(written, result.markdown)
  assert.equal(statSync(join(dataDir, 'snapshot.md')).mode & 0o777, 0o600)
})

test('save without a data directory simply does not save', (t) => {
  const { ledger } = setup(t)
  const result = reportForModel(ledger, { now: NOW, save: true })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.savedTo, undefined)
})

test('the rendered text is the Markdown body', (t) => {
  const { ledger } = setup(t)
  const result = reportForModel(ledger, { now: NOW })
  assert.match(renderReportResult(result), /^# 投递报表/)
  assert.equal(
    renderReportResult({ ok: false, code: 'E_LEDGER_WRITE', message: '写不进去' }),
    '[E_LEDGER_WRITE] 写不进去',
  )
})
