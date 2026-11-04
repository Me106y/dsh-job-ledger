/**
 * The panel/host API contract (TECH §11.2).
 *
 * Type-only, shared by both sides: the host imports it for its handlers and the client imports it to
 * type `usePoll`. Nothing here has a runtime representation, so neither bundle ships the other's code.
 *
 * The design listed pause/resume/halt and a reconcile "ack". They are deliberately absent here:
 * the executor cannot pause a run yet, and discrepancies are not stored, so acknowledging them is a
 * client-side dismissal rather than a server state change. A route that lies about doing something
 * is worse than a missing route.
 *
 * @module dsh-job-ledger/api/contract
 */

import type { AppState } from '../ledger/events.ts'
import type { ErrorCode } from '../shared/errors.ts'

/** Queue filter accepted by the read endpoint. */
export type ApiQueueFilter = 'new' | 'suspect' | 'filtered'

/** One row of the 待投 screen. */
export interface QueueRowView {
  readonly jobId: string
  readonly title: string
  readonly company: string
  readonly city: string
  /** Salary as shown by the platform, empty when absent. */
  readonly salary: string
  readonly reason: string
  readonly decision: 'new' | 'suspect'
  readonly duplicateOf?: string
  readonly firstSeenAt: string
}

/** GET queue. */
export interface QueueView {
  readonly revision: number
  readonly rows: readonly QueueRowView[]
  /** Total suspects in the ledger, so the tab can show a badge. */
  readonly suspects: number
  /** Total recoverable filtered jobs. */
  readonly filtered: number
}

/**
 * POST queue/update: one discovery pass run from the panel, plus the queue it produced.
 *
 * The counts are what the person needs to trust the refresh — "nothing new" and "everything was a
 * duplicate" look identical without them, and only one of those is worth retrying later.
 */
export interface QueueUpdateView {
  readonly revision: number
  readonly source: 'search' | 'recommend'
  readonly added: number
  readonly duplicates: number
  readonly filtered: number
  readonly suspects: number
  readonly invalid: number
  /** The new queue, so one round trip renders the result without waiting for the next poll. */
  readonly queue: QueueView
}

/** Where the current run is (TECH §11.2 `RunView`). */
export interface RunView {
  readonly runId?: string
  readonly state: 'idle' | 'queued' | 'running' | 'paused' | 'halted' | 'done' | 'done-with-errors'
  readonly total: number
  readonly done: number
  readonly current?: string
  readonly haltReason?: string
  readonly startedAt?: string
}

/** GET overview. */
export interface OverviewView {
  readonly revision: number
  readonly today: { readonly submitted: number; readonly quota: number }
  readonly uncertain: number
  readonly discrepancies: number
  readonly repliedYesterday: number
  readonly run: RunView
}

/** One row of a reconciliation discrepancy list. */
export interface ReconcileRowView {
  readonly jobId?: string
  readonly externalId?: string
  readonly title: string
  readonly company: string
}

/** GET reconcile. */
export interface ReconcileView {
  readonly revision: number
  readonly partial: boolean
  readonly ledgerOnly: readonly ReconcileRowView[]
  readonly platformOnly: readonly ReconcileRowView[]
}

/** Failure body shared by every route. */
export interface ApiError {
  readonly error: string
  readonly code: ErrorCode
  readonly values?: Readonly<Record<string, string>>
}

/** The target the settings screen shows and edits (PRD §5.10). */
export interface SettingsView {
  readonly revision: number
  readonly target: {
    readonly roles: readonly string[]
    readonly cities: readonly string[]
    readonly salaryMin: number
  }
  /**
   * Hard ceilings, shown for context; never writable. `salaryMinMax` is the bound the host accepts
   * for `target.salaryMin`, so the form can refuse an out-of-range value before the request.
   */
  readonly limits: {
    readonly runSize: number
    readonly daily: number
    readonly salaryMinMax: number
  }
  /** The user's own tracker sheet (PRD §5.11). `none` means the path is empty or unsupported. */
  readonly tracker: { readonly path: string; readonly format: 'xlsx' | 'numbers' | 'none' }
}

/** GET tracker: whether the configured sheet can be read, and what it looks like. */
export interface TrackerView {
  readonly revision: number
  readonly path: string
  readonly format: 'xlsx' | 'numbers' | 'none'
  /** Header cells of the first sheet, so the panel can show what was recognised. */
  readonly headers: readonly string[]
  /** Present when the last read failed; the panel shows it instead of pretending the sheet is fine. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** POST tracker/sync: one two-way pass. */
export interface TrackerSyncView {
  readonly revision: number
  readonly imported: number
  readonly matched: number
  readonly written: number
}

/**
 * The routes. Path parameters use `:name`.
 *
 * The client generates its calls from this map, so a typo becomes a type error on both sides.
 */
export interface Api {
  'GET queue': {
    query?: { filter?: ApiQueueFilter; limit?: number }
    response: QueueView
  }
  'GET overview': { response: OverviewView }
  'GET reconcile': { response: ReconcileView }
  'GET run': { response: RunView }
  'GET profile': { response: SettingsView }

  'POST run/start': { body: { ids: string[] }; response: RunView }
  'POST reconcile/run': { response: ReconcileView }
  'POST profile': {
    body: {
      roles?: readonly string[]
      cities?: readonly string[]
      salaryMin?: number
      /** Tracker sheet path; an empty string turns the feature off. */
      trackerPath?: string
    }
    response: SettingsView
  }
  /** One discovery pass with the current target; never applies. */
  'POST queue/update': { body?: { source?: 'search' | 'recommend' }; response: QueueUpdateView }
  /** Delete one pending posting: appends `job/status = skipped`. */
  'POST jobs/:id/skip': { response: { jobId: string; status: 'skipped' } }
  /** Read the configured tracker sheet's header. */
  'GET tracker': { response: TrackerView }
  /** Import the sheet's history and write new applications into it. */
  'POST tracker/sync': { response: TrackerSyncView }
  'POST apps/:id/state': {
    body: { state: AppState; note?: string }
    response: { appId: string; state: AppState }
  }
}

/** Route keys of {@link Api}. */
export type ApiRoute = keyof Api
