import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestJobs } from '../../src/discover/ingest.ts'
import { queueRows } from '../../src/ledger/queue.ts'
import { skipJob } from '../../src/ledger/skip.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-skip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @param ledger ledger @returns the job id ingestion created */
function seed(ledger: Ledger): string {
  const result = ingestJobs(
    ledger,
    [{ externalId: 'job_a1', title: '后端工程师', company: '字节跳动', city: '深圳', salaryRaw: '25-35K' }],
    { now: NOW, newId: () => 'j_1' },
  )
  assert.equal(result.added, 1)
  return 'j_1'
}

test('skipping a new posting records one event and takes it out of the queue', (t) => {
  const ledger = tempLedger(t)
  const jobId = seed(ledger)
  assert.equal(queueRows(ledger.projection, 'new').length, 1)

  const result = skipJob(ledger, jobId, AT)

  assert.deepEqual(result, { jobId, status: 'skipped', changed: true })
  assert.equal(ledger.projection.jobs.get(jobId)?.status, 'skipped')
  assert.equal(queueRows(ledger.projection, 'new').length, 0)
  // The verdict is untouched: skipping is the person's decision, not a re-judgement.
  assert.equal(ledger.projection.decisions.get(jobId)?.decision, 'new')
})

test('skipping twice is idempotent and appends nothing the second time', (t) => {
  const ledger = tempLedger(t)
  const jobId = seed(ledger)
  skipJob(ledger, jobId, AT)
  const before = ledger.report.appliedLines

  const again = skipJob(ledger, jobId, AT)

  assert.equal(again.changed, false)
  assert.equal(ledger.report.appliedLines, before)
})

test('a posting with an application cannot be skipped', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_2', company: '某公司', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })

  assert.throws(() => skipJob(ledger, job.id, AT), { code: 'E_ALREADY_APPLIED' })
  assert.equal(ledger.projection.jobs.get(job.id)?.status, 'new')
})

test('an unknown job is refused instead of guessed', (t) => {
  const ledger = tempLedger(t)

  assert.throws(() => skipJob(ledger, 'j_missing', AT), { code: 'E_INVALID_ARGUMENT' })
})
