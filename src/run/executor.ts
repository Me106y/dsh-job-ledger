/**
 * Run executor: one batch, one job at a time, every step recorded (TECH §9).
 *
 * The executor is deliberately the only place that combines the pieces: the ledger (claim, events),
 * the applier (browser actions), the judged verdict, evidence, pacing and the breaker. When a run
 * misbehaves there is exactly one file to read.
 *
 * What it will not do, by construction:
 * - click twice on the same job (lease + app-state check before every attempt);
 * - retry `uncertain` (the breaker halts the whole run, and the state machine has no path back);
 * - keep going after a fatal business code (the breaker's reason ends the loop);
 * - record a `submitted` without evidence (a failed screenshot write fails the job and halts).
 *
 * @module dsh-job-ledger/run/executor
 */

import { randomUUID } from 'node:crypto'

import type { AttemptOutcome } from './breaker.ts'
import { createBreaker, observe } from './breaker.ts'
import { gapMs, startRunVerdict } from './pacing.ts'
import { chatSnippet, saveEvidence } from './evidence.ts'
import type { NetworkSignal } from './attempt.ts'
import { haltReasonForFailure, judgeAttempt } from './attempt.ts'
import type {
  Application,
  GrantedBy,
  HaltReason,
  Job,
  RunSummary,
} from '../ledger/events.ts'
import { activeLease, blockingAppForJob } from '../ledger/project.ts'
import type { Projection } from '../ledger/project.ts'
import type { Ledger } from '../ledger/store.ts'
import { claimVerdict, leaseExpiry } from './lease.ts'
import { transition } from './machine.ts'
import type { RunState } from './machine.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** What the browser observed while sending one application. */
export interface SendResult {
  readonly clicked: boolean
  readonly network: NetworkSignal
  readonly resumeCardSeen: boolean
}

/** Evidence captured right after a submit. */
export interface CapturedEvidence {
  readonly png: Buffer
  readonly chat: string
}

/**
 * The browser actions a run needs.
 *
 * Kept separate from the CDP reader so the whole orchestration can be tested with a fake, and so
 * `run` never imports `cdp` (TECH §4).
 */
export interface JobApplier {
  /** Open the job page and wait until it is ready to be clicked. */
  prepare(job: Job): Promise<void>
  /** Click 立即沟通, send the greeting, and report what the page did. */
  send(job: Job, greeting: string): Promise<SendResult>
  /** Screenshot plus the chat transcript, for the evidence record. */
  capture(): Promise<CapturedEvidence>
}

/** Everything the runner needs; all side effects are injectable. */
export interface RunnerContext {
  readonly ledger: Ledger
  readonly applier: JobApplier
  readonly dataDir: string
  /** The greeting for one job. May read the resume, so it is allowed to be async. */
  readonly greeting: (job: Job) => string | Promise<string>
  readonly clock?: (() => number) | undefined
  readonly newAppId?: (() => string) | undefined
  readonly newRunId?: (() => string) | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /**
   * Called after one application reached `submitted` (PRD §5.11). Fire-and-forget: the sheet is a
   * copy, so a slow or failing write must never delay or fail the run.
   */
  readonly onSubmitted?: ((job: Job, appId: string, at: string) => void) | undefined
}

/** What the caller asked for. */
export interface RunRequest {
  readonly ids: readonly string[]
  readonly grantedBy: GrantedBy
}

/** How the run ended. */
export interface RunResult {
  readonly runId: string
  readonly outcome: Extract<RunState, 'done' | 'done-with-errors' | 'halted'>
  readonly haltReason?: HaltReason
  readonly summary: RunSummary
}

/**
 * Count today's confirmed submissions, across runs.
 *
 * Uses `createdAt` (the attempt's own time) rather than `updatedAt`, so a reply arriving today does
 * not consume today's quota.
 *
 * @param projection ledger state
 * @param now epoch ms
 * @returns number of applications created today that reached `submitted`
 */
export function todaySubmissions(projection: Projection, now: number): number {
  const day = new Date(now).toISOString().slice(0, 10)
  let count = 0
  for (const app of projection.apps.values()) {
    if (!app.createdAt.startsWith(day)) continue
    if (projection.reached.get(app.id)?.has('submitted') === true) count += 1
  }
  return count
}

/** The only object allowed to start a run in this process. */
export class JobRunner {
  readonly #ledger: Ledger
  readonly #applier: JobApplier
  readonly #dataDir: string
  readonly #greeting: (job: Job) => string | Promise<string>
  readonly #clock: () => number
  readonly #newAppId: () => string
  readonly #newRunId: () => string
  readonly #sleep: (ms: number) => Promise<void>
  readonly #onSubmitted: ((job: Job, appId: string, at: string) => void) | undefined
  #active = false

  /** @param context collaborators and injectable side effects */
  constructor(context: RunnerContext) {
    this.#ledger = context.ledger
    this.#applier = context.applier
    this.#dataDir = context.dataDir
    this.#greeting = context.greeting
    this.#clock = context.clock ?? (() => Date.now())
    this.#newAppId = context.newAppId ?? (() => `a_${randomUUID()}`)
    this.#newRunId = context.newRunId ?? (() => `r_${randomUUID()}`)
    this.#sleep = context.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    this.#onSubmitted = context.onSubmitted
  }

  /**
   * Run one batch.
   *
   * @param request job ids and who authorized them
   * @returns outcome and counts
   * @throws PluginError for refusals (active run, quota, bad ids) — before any event is written
   */
  async run(request: RunRequest): Promise<RunResult> {
    const now = this.#clock()
    const refusal = startRunVerdict({
      ids: request.ids,
      todaySubmitted: todaySubmissions(this.#ledger.projection, now),
      activeRun: this.#active,
    })
    if (refusal !== undefined) throw refusal

    this.#assertJobsExist(request.ids)

    this.#active = true
    try {
      return await this.#execute(request, now)
    } finally {
      this.#active = false
    }
  }

  /** @param ids requested jobs @throws PluginError when one is missing from the ledger */
  #assertJobsExist(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.#ledger.projection.jobs.has(id)) continue
      throw new PluginError('E_INVALID_ARGUMENT', { what: `job ${id} is not in the ledger` })
    }
  }

  async #execute(request: RunRequest, startMs: number): Promise<RunResult> {
    const runId = this.#newRunId()
    const ledger = this.#ledger
    ledger.append({
      type: 'run/start',
      runId,
      ids: request.ids,
      grantedBy: request.grantedBy,
      at: new Date(startMs).toISOString(),
    })

    const summary: { submitted: number; uncertain: number; failed: number; skipped: number } = {
      submitted: 0,
      uncertain: 0,
      failed: 0,
      skipped: 0,
    }
    let breaker = createBreaker()
    let haltReason: HaltReason | undefined

    for (const [index, jobId] of request.ids.entries()) {
      const now = this.#clock()
      const job = ledger.projection.jobs.get(jobId)
      if (job === undefined) {
        summary.failed += 1
        continue
      }

      // Two checks, both required: state catches "already applied", the lease catches "another
      // execution is clicking it right now".
      const claim = claimVerdict({
        blockingApp: blockingAppForJob(ledger.projection, job.id),
        lease: activeLease(ledger.projection, job.id, now),
        now,
      })
      if (!claim.ok) {
        summary.skipped += 1
        continue
      }

      const appId = this.#newAppId()
      const at = new Date(now).toISOString()
      ledger.append({ type: 'lease/grant', jobId: job.id, owner: runId, expiresAt: leaseExpiry(now), at })
      ledger.append({
        type: 'app/create',
        app: this.#newApplication(appId, job.id, runId, at),
        at,
      })

      let outcome: AttemptOutcome
      try {
        outcome = await this.#attempt(job, appId)
      } finally {
        ledger.append({ type: 'lease/release', jobId: job.id, at: new Date(this.#clock()).toISOString() })
      }

      // Count what was actually recorded, not the outcome kind: an evidence failure after a
      // confirmed send halts the run but leaves the application `uncertain`, and the summary has
      // to agree with the ledger.
      const recorded = ledger.projection.apps.get(appId)?.state
      if (recorded === 'submitted') summary.submitted += 1
      else if (recorded === 'uncertain') summary.uncertain += 1
      else summary.failed += 1

      const decision = observe(breaker, outcome)
      breaker = decision.state
      if (decision.halt) {
        haltReason = decision.reason
        ledger.append({
          type: 'run/halt',
          runId,
          reason: decision.reason,
          at: new Date(this.#clock()).toISOString(),
        })
        break
      }

      const last = index === request.ids.length - 1
      if (!last) await this.#sleep(gapMs(summary.submitted))
    }

    ledger.append({
      type: 'run/end',
      runId,
      summary,
      at: new Date(this.#clock()).toISOString(),
    })

    // `finish` from `running` can only land on done or done-with-errors, but the machine's return
    // type is the whole state union; narrow it here rather than widening the result type.
    const finished = transition('running', 'finish', { ...summary })
    const outcome: RunResult['outcome'] =
      haltReason !== undefined ? 'halted' : finished === 'done' ? 'done' : 'done-with-errors'

    return { runId, ...(haltReason === undefined ? {} : { haltReason }), outcome, summary }
  }

  /**
   * One attempt, with its state transitions written as it goes.
   *
   * @param job job to apply to
   * @param appId application id created for this attempt
   * @returns the breaker outcome
   */
  async #attempt(job: Job, appId: string): Promise<AttemptOutcome> {
    try {
      await this.#applier.prepare(job)
      const sent = await this.#applier.send(job, await this.#greeting(job))
      const verdict = judgeAttempt({
        clicked: sent.clicked,
        network: sent.network,
        resumeCardSeen: sent.resumeCardSeen,
      })

      if (verdict.kind === 'submitted') {
        try {
          const evidence = await this.#applier.capture()
          const path = saveEvidence(this.#dataDir, appId, evidence.png)
          this.#ledger.append({
            type: 'app/state',
            appId,
            state: 'submitted',
            note: chatSnippet(evidence.chat),
            evidence: path,
            at: new Date(this.#clock()).toISOString(),
          })
          const at = new Date(this.#clock()).toISOString()
          try {
            this.#onSubmitted?.(job, appId, at)
          } catch {
            // The sheet is a copy of the ledger; a failed write is reported on the next sync.
          }
          return { kind: 'submitted' }
        } catch (error) {
          // The send is confirmed by the network; only the proof is missing. Recording `failed`
          // would make the job eligible again and re-applying would duplicate a real application,
          // so it becomes `uncertain`: terminal until a human checks the platform.
          const code = error instanceof PluginError ? error.code : 'E_BODY_UNAVAILABLE'
          this.#ledger.append({
            type: 'app/state',
            appId,
            state: 'uncertain',
            note: `${userMessage(code)}（证据写入失败）`,
            at: new Date(this.#clock()).toISOString(),
          })
          return { kind: 'halt', reason: code === 'E_LEDGER_WRITE' ? 'ledger-write' : 'uncertain' }
        }
      }

      if (verdict.kind === 'uncertain') {
        this.#ledger.append({
          type: 'app/state',
          appId,
          state: 'uncertain',
          note: userMessage('E_SEND_UNCONFIRMED'),
          at: new Date(this.#clock()).toISOString(),
        })
        return { kind: 'uncertain' }
      }

      this.#ledger.append({
        type: 'app/state',
        appId,
        state: 'failed',
        note: userMessage(verdict.code),
        at: new Date(this.#clock()).toISOString(),
      })
      return verdict.halt === undefined
        ? { kind: 'failed' }
        : { kind: 'halt', reason: verdict.halt }
    } catch (error) {
      const code = error instanceof PluginError ? error.code : 'E_BODY_UNAVAILABLE'
      this.#ledger.append({
        type: 'app/state',
        appId,
        state: 'failed',
        note: userMessage(code),
        at: new Date(this.#clock()).toISOString(),
      })
      // A fatal code stops the run; anything else only fails this job.
      return failureOutcome(code)
    }
  }

  #newApplication(appId: string, jobId: string, runId: string, at: string): Application {
    return {
      id: appId,
      jobId,
      state: 'applying',
      source: 'applied',
      resumeId: 'online-v1',
      runId,
      createdAt: at,
      updatedAt: at,
    }
  }
}

/**
 * @param code failure code
 * @returns the breaker outcome for a failed attempt, reusing the attempt layer's mapping so there
 * is one answer to "which codes stop the run"
 */
function failureOutcome(code: Parameters<typeof userMessage>[0]): AttemptOutcome {
  const reason = haltReasonForFailure(code)
  return reason === undefined ? { kind: 'failed' } : { kind: 'halt', reason }
}
