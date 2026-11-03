/**
 * Read-only queue views over the projection (PRD §5.10 "待投" screen, TECH §12.3).
 *
 * A row is a job plus the verdict that put it there. The three filters are deliberately separate:
 * `filtered` is where rejected jobs stay retrievable (PRD §5.4), and `suspect` is the only queue
 * that requires a human — nothing lands there automatically.
 *
 * A job with **no verdict** appears in no queue at all. Backfilled and reconciled postings have no
 * decision event, and listing one as "new" would invite an application to something already applied
 * to — the exact failure this product exists to prevent.
 *
 * @module dsh-job-ledger/ledger/queue
 */

import type { JobSource } from './events.ts'
import type { Projection } from './project.ts'

/** Which slice of the queue to read. */
export type QueueFilter = 'new' | 'suspect' | 'filtered'

/** Default page size. The panel and the tool show the same view. */
export const QUEUE_LIMIT = 50

/** One row as the tool and the panel render it. */
export interface QueueRow {
  readonly jobId: string
  readonly title: string
  readonly company: string
  readonly city: string
  readonly decision: string
  readonly reason: string
  readonly salaryRaw?: string
  readonly salaryMin?: number
  readonly duplicateOf?: string
  readonly source: JobSource
  readonly firstSeenAt: string
}

/**
 * @param job job @param decision verdict @param filter requested slice @returns whether it belongs
 */
function matches(decision: string, status: string, filter: QueueFilter): boolean {
  if (filter === 'filtered') return status === 'filtered'
  if (filter === 'suspect') return status === 'new' && decision === 'suspect'
  return status === 'new' && decision === 'new'
}

/**
 * Build the rows for one filter, newest first.
 *
 * @param projection ledger state
 * @param filter which slice
 * @param limit page size
 * @returns rows, capped at `limit`
 */
export function queueRows(
  projection: Projection,
  filter: QueueFilter = 'new',
  limit: number = QUEUE_LIMIT,
): QueueRow[] {
  const rows: QueueRow[] = []

  for (const job of projection.jobs.values()) {
    const verdict = projection.decisions.get(job.id)
    if (verdict === undefined) continue
    const decision = verdict.decision
    if (!matches(decision, job.status, filter)) continue
    rows.push({
      jobId: job.id,
      title: job.title,
      company: job.company,
      city: job.city,
      decision,
      reason: verdict.reason,
      ...(job.salaryRaw === undefined ? {} : { salaryRaw: job.salaryRaw }),
      ...(job.salaryMin === undefined ? {} : { salaryMin: job.salaryMin }),
      ...(verdict.duplicateOf === undefined ? {} : { duplicateOf: verdict.duplicateOf }),
      source: job.source,
      firstSeenAt: job.firstSeenAt,
    })
  }

  // Newest first; the id breaks ties so the order is stable across replays.
  rows.sort(
    (left, right) =>
      Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt) || left.jobId.localeCompare(right.jobId),
  )
  return rows.slice(0, limit)
}

/**
 * @param projection ledger state @param filter which slice @returns how many rows exist before capping
 */
export function queueTotal(projection: Projection, filter: QueueFilter = 'new'): number {
  let total = 0
  for (const job of projection.jobs.values()) {
    const verdict = projection.decisions.get(job.id)
    if (verdict !== undefined && matches(verdict.decision, job.status, filter)) total += 1
  }
  return total
}
