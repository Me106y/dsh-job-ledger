import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Job } from '../../src/ledger/events.ts'
import { BLOCKING_STATES } from '../../src/ledger/project.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { SendResult } from '../../src/run/executor.ts'
import { JobRunner, todaySubmissions } from '../../src/run/executor.ts'
import type { CapturedEvidence, JobApplier } from '../../src/run/executor.ts'
import { PluginError } from '../../src/shared/errors.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param job job @returns a submitted send result */
function submitted(): SendResult {
  return { clicked: true, network: { kind: 'success' }, resumeCardSeen: true }
}

/** @param job job @returns a send that never got network confirmation */
function unconfirmed(): SendResult {
  return { clicked: true, network: { kind: 'none' }, resumeCardSeen: false }
}

/** @param reason human text @returns the evidence a submit should produce */
function evidence(): CapturedEvidence {
  return { png: Buffer.from('8950', 'hex'), chat: '你好，我想投递这个岗位' }
}

interface Behavior {
  readonly prepareThrows?: boolean
  readonly send?: SendResult
}

/** A browser that follows a per-job script. */
class FakeApplier implements JobApplier {
  readonly prepared: string[] = []
  readonly greetings: string[] = []
  readonly captured: string[] = []

  #behavior: (job: Job) => Behavior

  constructor(behavior: (job: Job) => Behavior) {
    this.#behavior = behavior
  }

  async prepare(job: Job): Promise<void> {
    this.prepared.push(job.id)
    if (this.#behavior(job).prepareThrows === true) throw new PluginError('E_NAV_TIMEOUT')
  }

  async send(job: Job, greeting: string): Promise<SendResult> {
    this.greetings.push(greeting)
    return this.#behavior(job).send ?? submitted()
  }

  async capture(): Promise<CapturedEvidence> {
    this.captured.push('capture')
    return evidence()
  }
}

/** @param t test context @returns a ledger plus its data dir */
function setup(t: { after(fn: () => void): void }): { ledger: Ledger; dataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return { ledger, dataDir: dir }
}

/** @param ledger ledger @param count how many jobs @returns the created jobs */
function seedJobs(ledger: Ledger, count: number): Job[] {
  const jobs: Job[] = []
  for (let index = 0; index < count; index += 1) {
    const job = makeJob({
      id: `j_${String(index)}`,
      company: `公司${String(index)}`,
      title: '后端工程师',
      city: '深圳',
      externalId: `ext_${String(index)}`,
      firstSeenAt: AT,
    })
    ledger.append({ type: 'job/add', job, at: AT })
    jobs.push(job)
  }
  return jobs
}

/** @param ledger ledger @param applier fake browser @returns a runner with deterministic ids and sleep */
function runner(ledger: Ledger, dataDir: string, applier: JobApplier) {
  let appSeq = 0
  const sleeps: number[] = []
  const machine = new JobRunner({
    ledger,
    applier,
    dataDir,
    greeting: () => '你好',
    clock: () => NOW,
    newAppId: () => {
      appSeq += 1
      return `a_${String(appSeq)}`
    },
    newRunId: () => 'r_1',
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { machine, sleeps }
}

test('a clean batch submits, records evidence, and ends done', async (t) => {
  const { ledger, dataDir } = setup(t)
  const jobs = seedJobs(ledger, 2)
  const applier = new FakeApplier(() => ({}))
  const { machine, sleeps } = runner(ledger, dataDir, applier)

  const result = await machine.run({
    ids: jobs.map((job) => job.id),
    grantedBy: { kind: 'panel', at: AT },
  })

  assert.equal(result.outcome, 'done')
  assert.deepEqual(result.summary, { submitted: 2, uncertain: 0, failed: 0, skipped: 0 })
  assert.equal(applier.prepared.length, 2)
  assert.equal(applier.captured.length, 2)

  const apps = [...ledger.projection.apps.values()]
  assert.equal(apps.length, 2)
  assert.ok(apps.every((app) => app.state === 'submitted'))
  assert.ok(apps.every((app) => app.evidence === `evidence/${app.id}.png`))
  assert.ok(apps.every((app) => (app.note ?? '').includes('投递')))

  // One gap between two attempts, inside the documented window.
  assert.equal(sleeps.length, 1)
  assert.ok((sleeps[0] ?? 0) >= 30_000 && (sleeps[0] ?? 0) < 90_000)
  assert.equal(ledger.projection.leases.size, 0)

  const run = ledger.projection.runs.get('r_1')
  assert.deepEqual(run?.summary, { submitted: 2, uncertain: 0, failed: 0, skipped: 0 })
})

test('an uncertain attempt halts the whole run and leaves the rest untouched', async (t) => {
  const { ledger, dataDir } = setup(t)
  const jobs = seedJobs(ledger, 3)
  const applier = new FakeApplier((job) =>
    job.id === jobs[0]?.id ? { send: unconfirmed() } : {},
  )
  const { machine } = runner(ledger, dataDir, applier)

  const result = await machine.run({
    ids: jobs.map((job) => job.id),
    grantedBy: { kind: 'model', at: AT },
  })

  assert.equal(result.outcome, 'halted')
  assert.equal(result.haltReason, 'uncertain')
  assert.deepEqual(result.summary, { submitted: 0, uncertain: 1, failed: 0, skipped: 0 })
  // The second and third job were never prepared: the breaker stops the run, not the job.
  assert.equal(applier.prepared.length, 1)
  assert.equal(ledger.projection.runs.get('r_1')?.halts.length, 1)
})

test('two consecutive failures halt the run', async (t) => {
  const { ledger, dataDir } = setup(t)
  const jobs = seedJobs(ledger, 3)
  const failing = (): Behavior => ({ send: { clicked: true, network: { kind: 'fatal', code: 'E_BODY_UNAVAILABLE' }, resumeCardSeen: false } })
  const applier = new FakeApplier(failing)
  const { machine } = runner(ledger, dataDir, applier)

  const result = await machine.run({ ids: jobs.map((job) => job.id), grantedBy: { kind: 'panel', at: AT } })

  assert.equal(result.outcome, 'halted')
  assert.equal(result.haltReason, 'consecutive-failures')
  assert.equal(result.summary.failed, 2)
  assert.equal(applier.prepared.length, 2)
})

test('a job with an existing application is skipped, not clicked again', async (t) => {
  const { ledger, dataDir } = setup(t)
  const [job] = seedJobs(ledger, 1)
  assert.ok(job !== undefined)
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })

  const applier = new FakeApplier(() => ({}))
  const { machine } = runner(ledger, dataDir, applier)

  const result = await machine.run({ ids: [job.id], grantedBy: { kind: 'panel', at: AT } })

  assert.deepEqual(result.summary, { submitted: 0, uncertain: 0, failed: 0, skipped: 1 })
  assert.equal(applier.prepared.length, 0)
})

test('a live lease skips the job without touching the page', async (t) => {
  const { ledger, dataDir } = setup(t)
  const [job] = seedJobs(ledger, 1)
  assert.ok(job !== undefined)
  ledger.append({
    type: 'lease/grant',
    jobId: job.id,
    owner: 'other-run',
    expiresAt: new Date(NOW + 60_000).toISOString(),
    at: AT,
  })

  const applier = new FakeApplier(() => ({}))
  const { machine } = runner(ledger, dataDir, applier)

  const result = await machine.run({ ids: [job.id], grantedBy: { kind: 'panel', at: AT } })

  assert.equal(result.summary.skipped, 1)
  assert.equal(applier.prepared.length, 0)
})

test('a refusal writes no events at all', async (t) => {
  const { ledger, dataDir } = setup(t)
  const before = ledger.report.appliedLines
  const { machine } = runner(ledger, dataDir, new FakeApplier(() => ({})))

  await assert.rejects(
    machine.run({ ids: ['j_missing'], grantedBy: { kind: 'panel', at: AT } }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_INVALID_ARGUMENT')
      return true
    },
  )
  assert.equal(ledger.report.appliedLines, before)
})

test('a second concurrent run is refused while the first is in flight', async (t) => {
  const { ledger, dataDir } = setup(t)
  const [job] = seedJobs(ledger, 1)
  assert.ok(job !== undefined)

  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const slow: JobApplier = {
    async prepare() {
      await gate
    },
    async send() {
      return submitted()
    },
    async capture() {
      return evidence()
    },
  }
  const { machine } = runner(ledger, dataDir, slow)

  const first = machine.run({ ids: [job.id], grantedBy: { kind: 'panel', at: AT } })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  await assert.rejects(
    machine.run({ ids: [job.id], grantedBy: { kind: 'panel', at: AT } }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_RUN_ACTIVE')
      return true
    },
  )

  release?.()
  const result = await first
  assert.equal(result.outcome, 'done')
})

test('evidence that cannot be written leaves the job uncertain and halts the run', async (t) => {
  const { ledger, dataDir } = setup(t)
  const jobs = seedJobs(ledger, 1)
  const applier = new FakeApplier(() => ({}))
  // Point dataDir at a regular file so the evidence directory cannot be created.
  const blocked = join(dataDir, 'events.jsonl')
  const { machine } = runner(ledger, blocked, applier)

  const result = await machine.run({ ids: jobs.map((job) => job.id), grantedBy: { kind: 'panel', at: AT } })

  assert.equal(result.outcome, 'halted')
  assert.equal(result.haltReason, 'ledger-write')
  // Not `failed`: the network confirmed the send, and a failed job is eligible to be applied to
  // again — which would duplicate a real application.
  const app = [...ledger.projection.apps.values()][0]
  assert.equal(app?.state, 'uncertain')
  assert.equal(result.summary.uncertain, 1)
  assert.equal(result.summary.failed, 0)
})

test("today's submissions count attempts made today, not replies arriving today", (t) => {
  const { ledger } = setup(t)
  const job = seedJobs(ledger, 1)[0]
  assert.ok(job !== undefined)

  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })
  ledger.append({
    type: 'app/create',
    app: { ...makeApp(job.id, 'replied'), id: 'a_old', createdAt: '2026-11-01T00:00:00.000Z' },
    at: AT,
  })

  assert.equal(todaySubmissions(ledger.projection, NOW), 1)
})

test('the applied-state list used by the claim check is the documented one', () => {
  for (const state of ['submitted', 'uncertain', 'replied', 'interview', 'offer', 'rejected', 'withdrawn'] as const) {
    assert.ok(BLOCKING_STATES.includes(state))
  }
})
