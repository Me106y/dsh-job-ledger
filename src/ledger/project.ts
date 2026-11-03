/**
 * In-memory projection of the event log.
 *
 * Every index here exists because some query would otherwise be O(n) on every keystroke of a
 * panel poll (TECH §6.4). They are maintained inside {@link applyEvent} and nowhere else, so "the
 * projection agrees with the log" is a property of one function rather than of the whole codebase.
 *
 * The projection stores facts, not judgements: it keeps the raw run events but does not decide what
 * they mean. Interpreting a run is the run layer's job, and that is what keeps `ledger` from
 * depending on `run` (TECH §4).
 *
 * @module dsh-job-ledger/ledger/project
 */

import type {
  AppState,
  Application,
  GrantedBy,
  HaltReason,
  Job,
  LedgerEvent,
  Lease,
  RunSummary,
} from './events.ts'
import type { Profile } from '../shared/profile.ts'
import { DEFAULT_PROFILE, mergeProfile } from '../shared/profile.ts'
import { PluginError } from '../shared/errors.ts'
import { assertTransition } from './states.ts'

/**
 * States after which a job is never applied to again (TECH §9.2).
 *
 * `failed` and `skipped` are absent on purpose: both have a human-decision path back into the
 * queue, so they must not block a future attempt.
 */
export const BLOCKING_STATES: readonly AppState[] = [
  'submitted',
  'uncertain',
  'replied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
]

/** States that count as "we already tried", which is what starts the 90-day cooldown (PRD §5.3). */
export const ATTEMPTED_STATES: readonly AppState[] = [
  'applying',
  ...BLOCKING_STATES,
  'failed',
]

/** Raw facts about one run, as written by the run layer. */
export interface RunRecord {
  readonly runId: string
  readonly ids: readonly string[]
  readonly grantedBy: GrantedBy
  readonly startedAt: string
  readonly halts: readonly { readonly reason: HaltReason; readonly at: string }[]
  summary?: RunSummary
  endedAt?: string
}

/** The dedupe verdict recorded for a job, kept so "why wasn't this applied to?" is answerable. */
export interface DecisionRecord {
  readonly decision: 'duplicate' | 'suspect' | 'filtered' | 'new'
  readonly reason: string
  readonly duplicateOf?: string
  readonly fitScore?: number
  readonly at: string
}

/** Counts from one discovery pass. */
export interface IngestRecord {
  readonly added: number
  readonly duplicates: number
  readonly filtered: number
  readonly invalid: number
  readonly at: string
}

/** Counts from one reconciliation pass. */
export interface ReconcileRecord {
  readonly matched: number
  readonly backfilled: number
  readonly discrepancies: number
  readonly at: string
}

/** The whole derived state of the ledger. Treat as read-only outside this module. */
export interface Projection {
  profile: Profile
  readonly jobs: Map<string, Job>
  readonly apps: Map<string, Application>
  readonly leases: Map<string, Lease>
  readonly runs: Map<string, RunRecord>
  readonly decisions: Map<string, DecisionRecord>
  readonly ingests: IngestRecord[]
  readonly reconciles: ReconcileRecord[]
  /** `platform:externalId` → jobId. Same-platform identity, O(1). */
  readonly byKey: Map<string, string>
  /** fingerprint → jobIds. Several postings can normalize to one role. */
  readonly byFingerprint: Map<string, string[]>
  /** `YYYY-MM-DD` → jobIds, so SimHash only compares inside the 45-day window. */
  readonly byDay: Map<string, string[]>
  /** app state → appIds, for the panel and the report. */
  readonly byState: Map<AppState, string[]>
  /**
   * appId → every state the application has ever been in.
   *
   * The funnel needs "did this ever get a reply?", which the current state cannot answer: a
   * rejected application looks identical whether or not it was ever replied to (PRD §5.8).
   */
  readonly reached: Map<string, Set<AppState>>
  /** jobId → appIds, newest last. */
  readonly appsByJob: Map<string, string[]>
  /** `companyNorm\u0001titleNorm` → appIds, for the cooldown check. */
  readonly appsByCompanyTitle: Map<string, string[]>
  /** Events whose `type` this version does not know. Counted, never fatal (TECH §6.1). */
  unknownEvents: number
  /** ISO time of the last applied event. */
  lastAppliedAt?: string
}

/** Key for the company+title indexes. `\u0001` cannot appear in normalized text. */
export function companyTitleKey(companyNorm: string, titleNorm: string): string {
  return `${companyNorm}\u0001${titleNorm}`
}

/** @returns an empty projection with the default profile */
export function createProjection(): Projection {
  return {
    profile: DEFAULT_PROFILE,
    jobs: new Map(),
    apps: new Map(),
    leases: new Map(),
    runs: new Map(),
    decisions: new Map(),
    ingests: [],
    reconciles: [],
    byKey: new Map(),
    byFingerprint: new Map(),
    byDay: new Map(),
    byState: new Map(),
    appsByJob: new Map(),
    appsByCompanyTitle: new Map(),
    reached: new Map(),
    unknownEvents: 0,
  }
}

/** @param iso ISO timestamp @returns the UTC day bucket `YYYY-MM-DD` */
export function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

function pushIndex<T extends Map<string, string[]>>(index: T, key: string, value: string): void {
  const existing = index.get(key)
  if (existing === undefined) index.set(key, [value])
  else existing.push(value)
}

function removeIndex(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key)
  if (existing === undefined) return
  const next = existing.filter((item) => item !== value)
  if (next.length === 0) index.delete(key)
  else index.set(key, next)
}

/**
 * Apply one event to the projection.
 *
 * Exported so tests can drive the projection directly, but only the ledger store should call it in
 * production: replay and live appends must take the same path or the two drift apart.
 *
 * @param projection state to mutate
 * @param event a known event, already validated by the store
 * @throws PluginError when the event contradicts the state (unknown id, illegal transition)
 */
export function applyEvent(projection: Projection, event: LedgerEvent): void {
  switch (event.type) {
    case 'profile/set': {
      projection.profile = mergeProfile(projection.profile, event.profile)
      break
    }
    case 'job/add': {
      const job = event.job
      projection.jobs.set(job.id, job)
      projection.byKey.set(`${job.platform}:${job.externalId}`, job.id)
      pushIndex(projection.byFingerprint, job.fingerprint, job.id)
      pushIndex(projection.byDay, dayOf(job.firstSeenAt), job.id)
      break
    }
    case 'job/decision': {
      projection.decisions.set(event.jobId, {
        decision: event.decision,
        reason: event.reason,
        ...(event.duplicateOf === undefined ? {} : { duplicateOf: event.duplicateOf }),
        ...(event.fitScore === undefined ? {} : { fitScore: event.fitScore }),
        at: event.at,
      })
      break
    }
    case 'job/status': {
      const job = projection.jobs.get(event.jobId)
      if (job === undefined) throw unknownJob(event.jobId)
      projection.jobs.set(job.id, { ...job, status: event.status })
      break
    }
    case 'app/create': {
      const app = event.app
      // A second create for one id would silently replace the application and desynchronise the
      // byState index: history would vanish while the indexes still pointed at the old state.
      if (projection.apps.has(app.id)) {
        throw new PluginError('E_LEDGER_STATE', { what: `app ${app.id} already exists` })
      }
      const job = projection.jobs.get(app.jobId)
      if (job === undefined) throw unknownJob(app.jobId)
      projection.apps.set(app.id, app)
      projection.reached.set(app.id, new Set([app.state]))
      pushIndex(projection.byState, app.state, app.id)
      pushIndex(projection.appsByJob, app.jobId, app.id)
      pushIndex(
        projection.appsByCompanyTitle,
        companyTitleKey(job.companyNorm, job.titleNorm),
        app.id,
      )
      break
    }
    case 'app/state': {
      const app = projection.apps.get(event.appId)
      if (app === undefined) throw unknownApp(event.appId)
      // Replaying a state that is already current is a no-op, not a violation: reconcile and
      // backfill can legitimately re-assert `submitted` after a partial run.
      if (app.state !== event.state) assertTransition(app.state, event.state)
      const next: Application = {
        ...app,
        state: event.state,
        updatedAt: event.at,
        ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
        ...(event.note === undefined ? {} : { note: event.note }),
      }
      projection.apps.set(next.id, next)
      projection.reached.get(next.id)?.add(next.state)
      if (app.state !== next.state) {
        removeIndex(projection.byState, app.state, app.id)
        pushIndex(projection.byState, next.state, app.id)
      }
      break
    }
    case 'lease/grant': {
      projection.leases.set(event.jobId, {
        jobId: event.jobId,
        owner: event.owner,
        expiresAt: event.expiresAt,
      })
      break
    }
    case 'lease/release': {
      projection.leases.delete(event.jobId)
      break
    }
    case 'ingest/summary': {
      projection.ingests.push({
        added: event.added,
        duplicates: event.duplicates,
        filtered: event.filtered,
        invalid: event.invalid,
        at: event.at,
      })
      break
    }
    case 'reconcile/summary': {
      projection.reconciles.push({
        matched: event.matched,
        backfilled: event.backfilled,
        discrepancies: event.discrepancies,
        at: event.at,
      })
      break
    }
    case 'run/start': {
      const existing = projection.runs.get(event.runId)
      if (existing === undefined) {
        projection.runs.set(event.runId, {
          runId: event.runId,
          ids: event.ids,
          grantedBy: event.grantedBy,
          startedAt: event.at,
          halts: [],
        })
      } else {
        // Resuming a paused run: keep the original start, refresh the authorization.
        projection.runs.set(event.runId, { ...existing, grantedBy: event.grantedBy })
      }
      break
    }
    case 'run/halt': {
      const run = projection.runs.get(event.runId)
      if (run === undefined) throw unknownRun(event.runId)
      projection.runs.set(event.runId, {
        ...run,
        halts: [...run.halts, { reason: event.reason, at: event.at }],
      })
      break
    }
    case 'run/end': {
      const run = projection.runs.get(event.runId)
      if (run === undefined) throw unknownRun(event.runId)
      projection.runs.set(event.runId, { ...run, summary: event.summary, endedAt: event.at })
      break
    }
  }
  projection.lastAppliedAt = event.at
}

// Entity-state problems are not disk failures: using E_LEDGER_WRITE here told the user to check
// free space for a bug that had nothing to do with the disk.
function unknownJob(id: string): PluginError {
  return new PluginError('E_LEDGER_STATE', { what: `job ${id} is not in the ledger` })
}

function unknownApp(id: string): PluginError {
  return new PluginError('E_LEDGER_STATE', { what: `app ${id} is not in the ledger` })
}

function unknownRun(id: string): PluginError {
  return new PluginError('E_LEDGER_STATE', { what: `run ${id} is not in the ledger` })
}

/* -------------------------------------------------------------------------- */
/* Queries used by the dedupe engine and the run layer                        */
/* -------------------------------------------------------------------------- */

/** @param app application @returns whether it blocks any future attempt on the same job */
export function blocksReapply(app: Application): boolean {
  return BLOCKING_STATES.includes(app.state)
}

/** @param app application @returns whether it counts as "we already tried" for cooldown */
export function countsAsAttempt(app: Application): boolean {
  return ATTEMPTED_STATES.includes(app.state)
}

/** @param projection ledger @param jobId job id @returns the app that blocks a re-apply, if any */
export function blockingAppForJob(projection: Projection, jobId: string): Application | undefined {
  const ids = projection.appsByJob.get(jobId) ?? []
  for (const id of ids) {
    const app = projection.apps.get(id)
    if (app !== undefined && blocksReapply(app)) return app
  }
  return undefined
}

/** @param projection ledger @param jobId job id @param now epoch ms @returns the live lease, if any */
export function activeLease(
  projection: Projection,
  jobId: string,
  now: number,
): Lease | undefined {
  const lease = projection.leases.get(jobId)
  if (lease === undefined) return undefined
  // TECH §6.5: `expiresAt < now` is free, so an expiry exactly at `now` still holds the job.
  // Treating it as free would let a second claim through on the boundary tick.
  return Date.parse(lease.expiresAt) >= now ? lease : undefined
}

/** @param projection ledger @param jobId job id @returns the job, or a coded error */
export function requireJob(projection: Projection, jobId: string): Job {
  const job = projection.jobs.get(jobId)
  if (job === undefined) throw unknownJob(jobId)
  return job
}

/** @param projection ledger @param state app state @returns apps in that state */
export function appsInState(projection: Projection, state: AppState): Application[] {
  const ids = projection.byState.get(state) ?? []
  return ids.flatMap((id) => {
    const app = projection.apps.get(id)
    return app === undefined ? [] : [app]
  })
}

/**
 * Jobs first seen inside a window, optionally restricted to one normalized city.
 *
 * Used by the SimHash pass: comparing against the whole ledger would be O(n²) within a year
 * (TECH §6.4).
 *
 * @param projection ledger
 * @param now epoch ms
 * @param windowDays window length
 * @param cityNorm optional city filter
 * @returns matching jobs
 */
export function jobsInWindow(
  projection: Projection,
  now: number,
  windowDays: number,
  cityNorm?: string,
): Job[] {
  const cutoff = now - windowDays * 86_400_000
  const result: Job[] = []
  for (const [day, ids] of projection.byDay) {
    if (Date.parse(`${day}T00:00:00.000Z`) < cutoff - 86_400_000) continue
    for (const id of ids) {
      const job = projection.jobs.get(id)
      if (job === undefined) continue
      if (Date.parse(job.firstSeenAt) < cutoff) continue
      if (cityNorm !== undefined && job.cityNorm !== cityNorm) continue
      result.push(job)
    }
  }
  return result
}

/**
 * Applications that start or extend a cooldown for a company+role pair.
 *
 * @param projection ledger
 * @param companyNorm normalized company
 * @param titleNorm normalized title
 * @returns attempted applications, newest first
 */
export function attemptsFor(
  projection: Projection,
  companyNorm: string,
  titleNorm: string,
): Application[] {
  const ids = projection.appsByCompanyTitle.get(companyTitleKey(companyNorm, titleNorm)) ?? []
  return ids
    .flatMap((id) => {
      const app = projection.apps.get(id)
      return app === undefined ? [] : [app]
    })
    .filter(countsAsAttempt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

