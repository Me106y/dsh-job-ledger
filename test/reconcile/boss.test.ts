import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reconcile } from '../../src/reconcile/boss.ts'
import type { DeliveredRow } from '../../src/reconcile/parse.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-reconcile-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @returns a deterministic id factory */
function ids(): { job: () => string; app: () => string } {
  let jobSeq = 0
  return {
    job: () => {
      jobSeq += 1
      return `j_back_${String(jobSeq)}`
    },
    app: () => `a_${String(jobSeq)}`,
  }
}

const ROW_A: DeliveredRow = {
  externalId: 'job_a1',
  company: '字节跳动',
  title: '后端工程师',
  city: '深圳',
  at: '2026-11-01T02:00:00.000Z',
}

test('a platform application the ledger never saw is backfilled', (t) => {
  const ledger = tempLedger(t)
  const factory = ids()

  const report = reconcile(ledger, [ROW_A], { now: NOW, newId: factory.job })

  assert.deepEqual(
    { matched: report.matched, backfilled: report.backfilled, partial: report.partial },
    { matched: 0, backfilled: 1, partial: false },
  )

  const job = [...ledger.projection.jobs.values()][0]
  assert.equal(job?.externalId, 'job_a1')
  assert.equal(job?.source, 'reconcile')

  const app = [...ledger.projection.apps.values()][0]
  assert.equal(app?.state, 'submitted')
  assert.equal(app?.source, 'reconcile')
  // The platform never says which resume went out.
  assert.equal(app?.resumeId, 'unknown')
  // The platform's timestamp is used, not the reconciliation time.
  assert.equal(app?.createdAt, '2026-11-01T02:00:00.000Z')

  assert.deepEqual(ledger.projection.reconciles.at(-1), {
    matched: 0,
    backfilled: 1,
    discrepancies: 0,
    at: AT,
  })
})

test('an application that is already known is matched and not re-added', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({
    type: 'app/create',
    app: { ...makeApp(job.id, 'submitted'), source: 'applied' },
    at: AT,
  })

  const report = reconcile(ledger, [ROW_A], { now: NOW })

  assert.equal(report.matched, 1)
  assert.equal(report.backfilled, 0)
  assert.deepEqual(report.discrepancies, [])
  // No second application was recorded for a posting we already knew about.
  assert.equal(ledger.projection.apps.size, 1)
})

test('a ledger application the platform does not know about is a discrepancy, not a rewrite', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: { ...makeApp(job.id, 'submitted'), source: 'applied' }, at: AT })

  const report = reconcile(ledger, [], { now: NOW })

  assert.equal(report.discrepancies.length, 1)
  assert.equal(report.discrepancies[0]?.jobId, job.id)
  // The state is untouched: the platform is not allowed to rewrite an outcome.
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'submitted')
})

test('an application the ledger thinks is queued but the platform has is corrected', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: { ...makeApp(job.id, 'queued'), source: 'applied' }, at: AT })

  const report = reconcile(ledger, [ROW_A], { now: NOW })

  assert.equal(report.backfilled, 1)
  const states = [...ledger.projection.apps.values()].map((app) => app.state).sort()
  // The queued attempt stays on record; a confirmed submission is added next to it.
  assert.deepEqual(states, ['queued', 'submitted'])
})

test('a matched terminal application is left alone', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: { ...makeApp(job.id, 'rejected'), source: 'applied' }, at: AT })

  const report = reconcile(ledger, [ROW_A], { now: NOW })

  assert.equal(report.matched, 1)
  assert.equal(report.backfilled, 0)
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'rejected')
})

test('running reconciliation twice does not duplicate the backfill', (t) => {
  const ledger = tempLedger(t)
  const first = reconcile(ledger, [ROW_A], { now: NOW, newId: ids().job })
  const second = reconcile(ledger, [ROW_A], { now: NOW, newId: ids().job })

  assert.equal(first.backfilled, 1)
  assert.equal(second.backfilled, 0)
  assert.equal(second.matched, 1)
  assert.equal(ledger.projection.jobs.size, 1)
  assert.equal(ledger.projection.apps.size, 1)
})

test('cold-start backfill is marked so the report can exclude it', (t) => {
  const ledger = tempLedger(t)
  reconcile(ledger, [ROW_A], { now: NOW, newId: ids().job, source: 'reconcile-backfill' })

  const app = [...ledger.projection.apps.values()][0]
  assert.equal(app?.source, 'reconcile-backfill')
})

test('a partial read is reported as partial, so discrepancies stay suspect', (t) => {
  const ledger = tempLedger(t)
  const report = reconcile(ledger, [], { now: NOW, partial: true })
  assert.equal(report.partial, true)
})
