/**
 * Read-only projections for the panel (TECH §12.3).
 *
 * Views are derived from the ledger on every request and never stored: the log is the truth, and a
 * cached view is a second truth that can disagree. They are deliberately small — the panel polls
 * once a second while a run is active.
 *
 * @module dsh-job-ledger/api/views
 */

import type { Projection } from '../ledger/project.ts'
import type { ReconcileReport } from '../reconcile/boss.ts'
import { appsInState, blockingAppForJob } from '../ledger/project.ts'
import { queueRows, queueTotal } from '../ledger/queue.ts'
import type { QueueFilter } from '../ledger/queue.ts'
import { todaySubmissions } from '../run/executor.ts'
import { DAILY_CAP } from '../run/pacing.ts'
import type { SettingsStore } from '../settings.ts'
import { MAX_SALARY_MIN } from '../settings.ts'
import { LIMITS } from '../shared/profile.ts'
import { trackerFormat } from '../tracker/sheet.ts'
import type {
  OverviewView,
  QueueRowView,
  QueueView,
  ReconcileRowView,
  ReconcileView,
  RunView,
  SettingsView,
} from './contract.ts'

/** Panel payload cap (TECH §11.4). */
export const QUEUE_PAGE_LIMIT = 200

/** What the API remembers about the current run between requests. */
export interface RunTracker {
  readonly run: RunView
  /** @param next replacement state */
  set(next: RunView): void
}

/**
 * @returns a tracker that starts idle
 */
export function createRunTracker(): RunTracker {
  let current: RunView = { state: 'idle', total: 0, done: 0 }
  return {
    get run(): RunView {
      return current
    },
    set(next: RunView): void {
      current = next
    },
  }
}

/**
 * Build the 待投 view.
 *
 * @param projection ledger state
 * @param filter which slice of the queue
 * @param limit page size
 * @returns rows plus the badge counts
 */
export function queueView(
  projection: Projection,
  filter: QueueFilter = 'new',
  limit: number = QUEUE_PAGE_LIMIT,
): QueueView {
  const rows: QueueRowView[] = queueRows(projection, filter, limit).map((row) => ({
    jobId: row.jobId,
    title: row.title,
    company: row.company,
    city: row.city,
    salary: row.salaryRaw ?? '',
    reason: row.reason,
    // A row in this view is either a plain candidate or a suspect; filtered rows live elsewhere.
    decision: row.decision === 'suspect' ? 'suspect' : 'new',
    ...(row.duplicateOf === undefined ? {} : { duplicateOf: row.duplicateOf }),
    ...(row.url === undefined ? {} : { url: row.url }),
    firstSeenAt: row.firstSeenAt,
  }))

  return {
    revision: projection.revision,
    rows,
    suspects: queueTotal(projection, 'suspect'),
    filtered: queueTotal(projection, 'filtered'),
  }
}

/**
 * Count applications that were replied to yesterday.
 *
 * The ledger records when an application last changed, so "yesterday" means "the last change fell
 * in yesterday's UTC day". It is an approximation, and it is used for one dashboard number.
 *
 * @param projection ledger state @param now epoch ms @returns the count
 */
function repliedYesterday(projection: Projection, now: number): number {
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10)
  let count = 0
  for (const app of projection.apps.values()) {
    if (!app.updatedAt.startsWith(yesterday)) continue
    const reached = projection.reached.get(app.id)
    if (reached?.has('replied') === true || reached?.has('interview') === true || reached?.has('offer') === true) {
      count += 1
    }
  }
  return count
}

/**
 * Build the 概览 view.
 *
 * @param projection ledger state
 * @param now epoch ms
 * @param run current run state
 * @param discrepancies how many discrepancies the last reconcile found
 * @returns the dashboard numbers
 */
export function overviewView(
  projection: Projection,
  now: number,
  run: RunView,
  discrepancies = 0,
): OverviewView {
  return {
    revision: projection.revision,
    today: { submitted: todaySubmissions(projection, now), quota: DAILY_CAP },
    uncertain: appsInState(projection, 'uncertain').length,
    discrepancies,
    repliedYesterday: repliedYesterday(projection, now),
    run,
  }
}

/**
 * Build the 对账差异 view.
 *
 * @param projection ledger state
 * @param ledgerOnly applications the ledger has and the platform did not report
 * @param platformOnly platform rows the ledger could not match
 * @param partial whether only part of the platform history was read
 * @returns the two lists
 */
export function reconcileView(
  projection: Projection,
  report: ReconcileReport | undefined,
): ReconcileView {
  const rows = (jobId: string): ReconcileRowView => {
    const job = projection.jobs.get(jobId)
    return { jobId, title: job?.title ?? '', company: job?.company ?? '' }
  }

  return {
    revision: projection.revision,
    partial: report?.partial ?? false,
    ledgerOnly: (report?.discrepancies ?? []).map((row) => rows(row.jobId)),
    platformOnly: (report?.platformOnly ?? []).map((row) => ({
      externalId: row.externalId,
      title: row.title,
      company: row.company,
    })),
  }
}

/**
 * Whether a job may be applied to right now, for the row-level hint.
 *
 * @param projection ledger state @param jobId job @param now epoch ms @returns the blocking reason
 */
export function blockedReason(
  projection: Projection,
  jobId: string,
  now: number,
): 'leased' | 'already-applied' | undefined {
  const lease = projection.leases.get(jobId)
  if (lease !== undefined && Date.parse(lease.expiresAt) >= now) return 'leased'
  if (blockingAppForJob(projection, jobId) !== undefined) return 'already-applied'
  return undefined
}

/**
 * Build the 设置 view: the editable target plus the hard ceilings.
 *
 * Settings are not events, so the revision is the ledger's — the screen does not poll, it loads once
 * and refreshing it is not a correctness issue.
 *
 * @param settings live settings store
 * @param revision ledger revision
 * @returns the editable target and the read-only limits
 */
export function settingsView(settings: SettingsStore, revision: number): SettingsView {
  const target = settings.target
  const path = settings.profile.tracker.path
  return {
    revision,
    target: {
      roles: [...target.roles],
      cities: [...target.cities],
      salaryMin: target.salaryMin,
      jobType: target.jobType,
    },
    tracker: { path, format: trackerFormat(path) ?? 'none' },
    limits: { runSize: LIMITS.runSize, daily: LIMITS.daily, salaryMinMax: MAX_SALARY_MIN },
  }
}
