/**
 * Event schema v1: the only shapes that may reach `events.jsonl`.
 *
 * The ledger is the single source of truth (PRD §6), so this module is the one place that defines
 * what an event *is*. Each event must be self-contained: replaying it must not depend on the
 * previous line (TECH §6.1), because that is what lets the log be truncated, audited and, later,
 * replayed in parallel.
 *
 * Adding a type is a schema change: extend the union here and the projection in `project.ts` in
 * the same commit, or the event becomes a silent no-op.
 *
 * @module dsh-job-ledger/ledger/events
 */

import type { ProfilePatch } from '../shared/profile.ts'

/** Current schema version. `v` only ever grows; a newer `v` refuses to load (TECH §6.3). */
export const EVENT_VERSION = 1 as const

/** v0.1 speaks to BOSS only (PRD §3.2). */
export type Platform = 'boss'

/** Where a job came from. `reconcile` means the platform told us, not that we applied. */
export type JobSource = 'search' | 'recommend' | 'manual' | 'reconcile'

/** Job lifecycle. Application state lives on `Application`, not here. */
export type JobStatus = 'new' | 'queued' | 'filtered' | 'skipped'

/** Application state machine states (PRD §5.6). */
export type AppState =
  | 'new'
  | 'queued'
  | 'applying'
  | 'submitted'
  | 'uncertain'
  | 'replied'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn'
  | 'failed'
  | 'skipped'

/** Why an application exists. Backfill is deliberately distinguishable from a real click. */
export type AppSource = 'applied' | 'reconcile' | 'reconcile-backfill'

/** A posting, as stored. Normalized fields are computed once at ingestion and never recomputed. */
export interface Job {
  readonly id: string
  readonly platform: Platform
  /** Platform id (`encryptJobId` on BOSS). Falls back to a normalized URL when absent. */
  readonly externalId: string
  readonly url: string
  readonly title: string
  readonly company: string
  readonly companyNorm: string
  readonly titleNorm: string
  readonly city: string
  readonly cityNorm: string
  readonly salaryRaw?: string
  readonly salaryMin?: number
  /** JD text, truncated at ingestion (TECH §6.2). */
  readonly jdText?: string
  /**
   * 64-bit SimHash of the JD as 16 hex chars; `''` means "no JD" (backfill data), which disables
   * the similarity checks for that job (TECH §7.3). A JSON number cannot hold 64 bits without
   * losing precision, hence the hex string.
   */
  readonly jdHash: string
  readonly fingerprint: string
  readonly postedAt?: string
  readonly firstSeenAt: string
  readonly status: JobStatus
  readonly source: JobSource
}

/** One application attempt. A job has at most one active application per cooldown window. */
export interface Application {
  readonly id: string
  readonly jobId: string
  readonly state: AppState
  readonly source: AppSource
  /** Even when only `online-v1` exists, it is recorded: without it, history cannot be attributed later. */
  readonly resumeId: string
  readonly greetText?: string
  /** Relative evidence path (`evidence/<appId>.png`). Never synthesized (PRD §5.5). */
  readonly evidence?: string
  /** Reason shown next to the state, e.g. why an attempt is `failed` or `uncertain`. */
  readonly note?: string
  readonly runId?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A short exclusive hold on a job, so two runs cannot click the same posting (TECH §6.5). */
export interface Lease {
  readonly jobId: string
  readonly owner: string
  readonly expiresAt: string
}

/** Who authorized a run. Recorded so "who clicked this" is answerable after the fact. */
export type GrantedBy =
  | { readonly kind: 'panel'; readonly at: string }
  | { readonly kind: 'model'; readonly at: string }

/** Why a run stopped. `paused` is the only reason that has a resume path. */
export type HaltReason =
  | 'paused'
  | 'uncertain'
  | 'captcha'
  | 'rate-limited'
  | 'ip-restricted'
  | 'account-restricted'
  | 'account-risk'
  | 'stoken-expired'
  | 'consecutive-failures'
  | 'cdp-disconnected'
  | 'host-restart'
  | 'ledger-write'

/** Counts written when a run ends. */
export interface RunSummary {
  readonly submitted: number
  readonly uncertain: number
  readonly failed: number
  readonly skipped: number
}

/** Fields every event carries. */
export interface EventEnvelope {
  readonly v: number
  readonly at: string
}

/** A config update. Merged, never replaced (TECH §14). */
export interface ProfileSetEvent extends EventEnvelope {
  readonly type: 'profile/set'
  readonly profile: ProfilePatch
}

/** A new posting entered the ledger. */
export interface JobAddEvent extends EventEnvelope {
  readonly type: 'job/add'
  readonly job: Job
}

/** The dedupe verdict for a posting, including why. Auditability is the point. */
export interface JobDecisionEvent extends EventEnvelope {
  readonly type: 'job/decision'
  readonly jobId: string
  readonly decision: 'duplicate' | 'suspect' | 'filtered' | 'new'
  readonly reason: string
  readonly duplicateOf?: string
  /** Model-provided ranking hint; recorded so a later report can be reproduced. */
  readonly fitScore?: number
}

/** A job's coarse status changed. */
export interface JobStatusEvent extends EventEnvelope {
  readonly type: 'job/status'
  readonly jobId: string
  readonly status: JobStatus
}

/** An application was created. */
export interface AppCreateEvent extends EventEnvelope {
  readonly type: 'app/create'
  readonly app: Application
}

/** An application changed state. History is appended, never edited. */
export interface AppStateEvent extends EventEnvelope {
  readonly type: 'app/state'
  readonly appId: string
  readonly state: AppState
  readonly note?: string
  readonly evidence?: string
}

/** A lease was taken on a job. */
export interface LeaseGrantEvent extends EventEnvelope {
  readonly type: 'lease/grant'
  readonly jobId: string
  readonly owner: string
  readonly expiresAt: string
}

/** A lease was released. */
export interface LeaseReleaseEvent extends EventEnvelope {
  readonly type: 'lease/release'
  readonly jobId: string
}

/** Result of one discovery pass. */
export interface IngestSummaryEvent extends EventEnvelope {
  readonly type: 'ingest/summary'
  readonly added: number
  readonly duplicates: number
  readonly filtered: number
  readonly invalid: number
}

/** Result of one reconciliation pass. */
export interface ReconcileSummaryEvent extends EventEnvelope {
  readonly type: 'reconcile/summary'
  readonly matched: number
  readonly backfilled: number
  readonly discrepancies: number
}

/** A run started (or resumed a paused one). */
export interface RunStartEvent extends EventEnvelope {
  readonly type: 'run/start'
  readonly runId: string
  readonly ids: readonly string[]
  readonly grantedBy: GrantedBy
}

/** A run stopped: circuit breaker, user pause, or host restart. */
export interface RunHaltEvent extends EventEnvelope {
  readonly type: 'run/halt'
  readonly runId: string
  readonly reason: HaltReason
}

/** A run ended. */
export interface RunEndEvent extends EventEnvelope {
  readonly type: 'run/end'
  readonly runId: string
  readonly summary: RunSummary
}

/** Everything that can be appended. */
export type LedgerEvent =
  | ProfileSetEvent
  | JobAddEvent
  | JobDecisionEvent
  | JobStatusEvent
  | AppCreateEvent
  | AppStateEvent
  | LeaseGrantEvent
  | LeaseReleaseEvent
  | IngestSummaryEvent
  | ReconcileSummaryEvent
  | RunStartEvent
  | RunHaltEvent
  | RunEndEvent

/** Every event type name, for exhaustive checks in the projection. */
export const EVENT_TYPES = [
  'profile/set',
  'job/add',
  'job/decision',
  'job/status',
  'app/create',
  'app/state',
  'lease/grant',
  'lease/release',
  'ingest/summary',
  'reconcile/summary',
  'run/start',
  'run/halt',
  'run/end',
] as const

/** A valid event type name. */
export type EventType = (typeof EVENT_TYPES)[number]

/**
 * `Omit` that distributes over a union, so `EventInput` keeps its discriminated `type`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * What callers hand to the ledger: the event minus the fields the ledger owns.
 *
 * `v` is added by the store. `at` may be supplied by the caller (resumes, backfill with platform
 * timestamps) and is defaulted to "now" otherwise — the ledger never invents a time for an event
 * that already has one.
 */
export type EventInput = DistributiveOmit<LedgerEvent, 'v' | 'at'> & { readonly at?: string }

/** Whether a value is one of the known type names. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}
