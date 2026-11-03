import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestJobs } from '../../src/discover/ingest.ts'
import type { RawJob } from '../../src/discover/parse.ts'
import { QUEUE_LIMIT, queueRows, queueTotal } from '../../src/ledger/queue.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-queue-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @returns a deterministic id factory */
function counter(): () => string {
  let next = 0
  return () => {
    next += 1
    return `j_${String(next)}`
  }
}

const BATCH: readonly RawJob[] = [
  { externalId: 'job_a1', title: '后端工程师', company: '字节跳动', city: '深圳', salaryRaw: '25-35K' },
  { externalId: 'job_a2', title: '后端工程师', company: '北京市字节跳动', city: '深圳市' },
  { externalId: 'job_a3', title: '销售代表', company: '某贸易公司', city: '深圳' },
]

test('new holds the applied candidates, filtered holds the recoverable ones', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  const fresh = queueRows(ledger.projection, 'new')
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]?.title, '后端工程师')
  assert.equal(fresh[0]?.reason, 'new')

  const filtered = queueRows(ledger.projection, 'filtered')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.reason, 'excluded-keyword')

  assert.equal(queueTotal(ledger.projection, 'new'), 1)
  assert.equal(queueTotal(ledger.projection, 'filtered'), 1)
  assert.equal(queueTotal(ledger.projection, 'suspect'), 0)
})

test('a duplicate never shows up in any queue', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  // The duplicate is not even recorded, so it cannot leak into a queue.
  const stored = [...ledger.projection.jobs.values()].map((job) => job.externalId)
  assert.deepEqual(stored.sort(), ['job_a1', 'job_a3'])
  for (const filter of ['new', 'suspect', 'filtered'] as const) {
    assert.equal(queueRows(ledger.projection, filter).length, filter === 'new' ? 1 : filter === 'filtered' ? 1 : 0)
  }
})

test('suspects are a queue of their own, because a human has to decide', (t) => {
  const ledger = tempLedger(t)
  const old = makeJob({
    company: '字节跳动',
    title: '后端工程师',
    city: '深圳',
    firstSeenAt: '2026-09-04T00:00:00.000Z',
    externalId: 'old_posting',
  })
  ledger.append({ type: 'job/add', job: old, at: '2026-09-04T00:00:00.000Z' })

  ingestJobs(
    ledger,
    [{ externalId: 'new_posting', title: '后端工程师', company: '字节跳动', city: '深圳' }],
    { now: NOW, newId: counter() },
  )

  const suspects = queueRows(ledger.projection, 'suspect')
  assert.equal(suspects.length, 1)
  assert.equal(suspects[0]?.decision, 'suspect')
  assert.equal(suspects[0]?.duplicateOf, old.id)
  assert.equal(queueRows(ledger.projection, 'new').length, 0)
})

test('rows are newest first and the page is capped while the total is not', (t) => {
  const ledger = tempLedger(t)
  const base = Date.parse('2026-11-01T00:00:00.000Z')

  for (let index = 0; index < 3; index += 1) {
    const job = makeJob({
      id: `j_old${String(index)}`,
      company: `公司${String(index)}`,
      title: '后端工程师',
      city: '深圳',
      externalId: `ext_${String(index)}`,
      firstSeenAt: new Date(base + index * 60_000).toISOString(),
    })
    ledger.append({ type: 'job/add', job, at: job.firstSeenAt })
    ledger.append({
      type: 'job/decision',
      jobId: job.id,
      decision: 'new',
      reason: 'new',
      at: job.firstSeenAt,
    })
  }

  const rows = queueRows(ledger.projection, 'new', 2)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.company, '公司2')
  assert.equal(rows[1]?.company, '公司1')
  assert.equal(queueTotal(ledger.projection, 'new'), 3)
})

test('the default page size is the documented cap', () => {
  assert.equal(QUEUE_LIMIT, 50)
})

test('a job with no verdict never shows up as a candidate', (t) => {
  // Backfilled and reconciled postings have no decision event. Listing one as "new" would invite
  // an application to a job that was already applied to.
  const ledger = tempLedger(t)
  const backfilled = makeJob({
    company: '某公司',
    title: '后端工程师',
    city: '深圳',
    externalId: 'backfilled',
    source: 'reconcile',
  })
  ledger.append({ type: 'job/add', job: backfilled, at: NOW.toString() })

  for (const filter of ['new', 'suspect', 'filtered'] as const) {
    assert.equal(queueRows(ledger.projection, filter).length, 0)
    assert.equal(queueTotal(ledger.projection, filter), 0)
  }
})
