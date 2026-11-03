import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { blockingAppForJob } from '../../src/ledger/project.ts'
import { Ledger } from '../../src/ledger/store.ts'
import { INTERRUPTED_NOTE, recoverInterrupted } from '../../src/run/recovery.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-recovery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

test('an application left in applying becomes uncertain', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'applying'), at: AT })

  const recovered = recoverInterrupted(ledger, NOW)

  assert.equal(recovered, 1)
  const app = ledger.projection.apps.get('a_1')
  assert.equal(app?.state, 'uncertain')
  assert.equal(app?.note, INTERRUPTED_NOTE)
})

test('a recovered application blocks the job from being applied to again', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'applying'), at: AT })
  // Before recovery the job is claimable: applying is transient, not blocking.
  assert.equal(blockingAppForJob(ledger.projection, job.id), undefined)

  recoverInterrupted(ledger, NOW)

  assert.equal(blockingAppForJob(ledger.projection, job.id)?.id, 'a_1')
})

test('recovery is idempotent and leaves finished applications alone', (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'applying'), at: AT })
  ledger.append({
    type: 'app/create',
    app: { ...makeApp(job.id, 'submitted'), id: 'a_2' },
    at: AT,
  })

  recoverInterrupted(ledger, NOW)
  const second = recoverInterrupted(ledger, NOW)

  assert.equal(second, 0)
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'uncertain')
  assert.equal(ledger.projection.apps.get('a_2')?.state, 'submitted')
})

test('nothing to recover is not an error', (t) => {
  const ledger = tempLedger(t)
  assert.equal(recoverInterrupted(ledger, NOW), 0)
})
