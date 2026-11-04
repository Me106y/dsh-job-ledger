import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blockedReason, createRunTracker, overviewView, queueView, reconcileView } from '../../src/api/views.ts'
import { ingestJobs } from '../../src/discover/ingest.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-views-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

test('the queue view carries the row facts and the tab badges', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(
    ledger,
    [
      { externalId: 'job_a1', title: '后端工程师', company: '字节跳动', city: '深圳', salaryRaw: '25-35K' },
      { externalId: 'job_a3', title: '销售代表', company: '某贸易公司', city: '深圳' },
    ],
    { now: NOW, newId: (() => { let n = 0; return () => { n += 1; return `j_${String(n)}` } })() },
  )

  const view = queueView(ledger.projection, 'new')

  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0]?.salary, '25-35K')
  assert.equal(view.rows[0]?.decision, 'new')
  // The title links to the posting's own page.
  assert.match(view.rows[0]?.url ?? '', /^https:\/\/www\.zhipin\.com\/job_detail\//)
  assert.equal(view.filtered, 1)
  assert.equal(view.suspects, 0)
  assert.ok(view.revision > 0)
})

test('the overview counts today, the queue, and the last reconcile', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })
  ledger.append({
    type: 'app/create',
    app: { ...makeApp(job.id, 'uncertain'), id: 'a_2' },
    at: AT,
  })

  const tracker = createRunTracker()
  const view = overviewView(ledger.projection, NOW, tracker.run, 3)

  assert.deepEqual(view.today, { submitted: 1, quota: 30 })
  assert.equal(view.uncertain, 1)
  assert.equal(view.discrepancies, 3)
  assert.equal(view.run.state, 'idle')
})

test('a reply that landed yesterday is counted, today’s is not', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })

  ledger.append({
    type: 'app/create',
    app: {
      ...makeApp(job.id, 'replied'),
      createdAt: AT,
      updatedAt: '2026-11-02T10:00:00.000Z',
    },
    at: AT,
  })
  ledger.append({
    type: 'app/create',
    app: { ...makeApp(job.id, 'replied'), id: 'a_2', createdAt: AT },
    at: AT,
  })

  assert.equal(overviewView(ledger.projection, NOW, createRunTracker().run).repliedYesterday, 1)
})

test('the reconcile view lists both sides and flags a partial read', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })

  const view = reconcileView(ledger.projection, {
    matched: 0,
    backfilled: 1,
    partial: true,
    discrepancies: [
      { jobId: job.id, company: '字节跳动', title: '后端工程师', city: '深圳', state: 'submitted' },
    ],
    platformOnly: [{ externalId: 'job_x', company: '美团', title: '数据工程师' }],
  })

  assert.equal(view.partial, true)
  assert.deepEqual(view.ledgerOnly[0], {
    jobId: job.id,
    title: '后端工程师',
    company: '字节跳动',
  })
  assert.deepEqual(view.platformOnly[0], {
    externalId: 'job_x',
    title: '数据工程师',
    company: '美团',
  })
})

test('a job with a live lease or an application is marked blocked', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  assert.equal(blockedReason(ledger.projection, job.id, NOW), undefined)

  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })
  assert.equal(blockedReason(ledger.projection, job.id, NOW), 'already-applied')

  const other = makeJob({
    id: 'j_2',
    company: '美团',
    title: '后端工程师',
    city: '北京',
    externalId: 'ext_2',
  })
  ledger.append({ type: 'job/add', job: other, at: AT })
  ledger.append({
    type: 'lease/grant',
    jobId: other.id,
    owner: 'r_1',
    expiresAt: new Date(NOW + 1_000).toISOString(),
    at: AT,
  })
  assert.equal(blockedReason(ledger.projection, other.id, NOW), 'leased')
})
