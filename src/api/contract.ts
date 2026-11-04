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
  /** Hard ceilings, shown for context; never writable. */
  readonly limits: { readonly runSize: number; readonly daily: number }
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
    body: { roles?: readonly string[]; cities?: readonly string[]; salaryMin?: number }
    response: SettingsView
  }
  'POST apps/:id/state': {
    body: { state: AppState; note?: string }
    response: { appId: string; state: AppState }
  }
}

/** Route keys of {@link Api}. */
export type ApiRoute = keyof Api
