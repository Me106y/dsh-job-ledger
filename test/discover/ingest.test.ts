import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestJobs } from '../../src/discover/ingest.ts'
import type { RawJob } from '../../src/discover/parse.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-ingest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

/** @returns a fresh id factory for deterministic assertions */
function counter(): () => string {
  let next = 0
  return () => {
    next += 1
    return `j_${String(next)}`
  }
}

const BATCH: readonly RawJob[] = [
  { externalId: 'job_a1', title: '后端工程师', company: '字节跳动', city: '深圳' },
  // Same role, second HR: duplicate by fingerprint.
  { externalId: 'job_a2', title: '高级后端工程师', company: '北京市字节跳动', city: '深圳市' },
  { externalId: 'job_a3', title: '销售代表', company: '某贸易公司', city: '深圳' },
]

test('one batch writes a job and a verdict for every card, then a summary', (t) => {
  const ledger = tempLedger(t)

  const result = ingestJobs(ledger, BATCH, { now: NOW, newId: counter(), invalid: 1 })

  assert.equal(result.added, 1)
  assert.equal(result.duplicates, 1)
  assert.equal(result.filtered, 1)
  assert.equal(result.invalid, 1)
  assert.equal(result.decisions.length, 3)

  const projection = ledger.projection
  // The duplicate is counted but not recorded: re-scanning must not grow the log.
  assert.equal(projection.jobs.size, 2)
  assert.equal(projection.decisions.size, 2)
  assert.deepEqual(projection.ingests.at(-1), {
    added: 1,
    duplicates: 1,
    filtered: 1,
    invalid: 1,
    at: new Date(NOW).toISOString(),
  })
})

test('duplicates and filtered cards are kept with a status the queue ignores', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  const statuses = [...ledger.projection.jobs.values()].map((job) => job.status).sort()
  assert.deepEqual(statuses, ['filtered', 'new'])
})

test('the duplicate verdict points at the posting it duplicates', (t) => {
  const ledger = tempLedger(t)
  const result = ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  const duplicate = result.decisions.find((decision) => decision.kind === 'duplicate')
  assert.equal(duplicate?.reason, 'same-role-company')
  assert.equal(duplicate?.duplicateOf, result.decisions[0]?.jobId)
})

test('re-ingesting the same batch adds nothing', (t) => {
  const ledger = tempLedger(t)
  ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  const second = ingestJobs(ledger, BATCH, { now: NOW, newId: counter() })

  assert.equal(second.added, 0)
  assert.equal(second.duplicates, 3)
  assert.equal(ledger.projection.jobs.size, 2)
  assert.ok(second.decisions.every((decision) => decision.kind === 'duplicate'))
  assert.equal(second.decisions[0]?.reason, 'same-posting')
})

test('a posting seen outside the window becomes a suspect, not a drop', (t) => {
  const ledger = tempLedger(t)
  const old = makeJob({
    company: '字节跳动',
    title: '后端工程师',
    city: '深圳',
    firstSeenAt: '2026-09-04T00:00:00.000Z',
    externalId: 'old_posting',
  })
  ledger.append({ type: 'job/add', job: old, at: '2026-09-04T00:00:00.000Z' })

  const result = ingestJobs(
    ledger,
    [{ externalId: 'new_posting', title: '后端工程师', company: '字节跳动', city: '深圳' }],
    { now: NOW, newId: counter() },
  )

  assert.equal(result.suspects, 1)
  assert.equal(result.added, 1)
  assert.equal(result.decisions[0]?.reason, 'same-title-different-jd')
})

test('the JD is truncated at ingestion so one posting cannot overflow a line', (t) => {
  const ledger = tempLedger(t)
  const huge: RawJob = {
    externalId: 'job_big',
    title: '后端工程师',
    company: '某公司',
    city: '深圳',
    jdText: 'x'.repeat(30_000),
  }

  ingestJobs(ledger, [huge], { now: NOW, newId: counter() })

  const stored = [...ledger.projection.jobs.values()][0]
  assert.equal(stored?.jdText?.length, 20_000)
})
