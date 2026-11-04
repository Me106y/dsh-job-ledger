/**
 * Recording a person's decision not to pursue a posting (PRD §5.10, decision #34).
 *
 * `skipped` is a job status, not an application state: the posting never became an application, so
 * there is no application to move. The distinction matters for the ledger's guarantees — deleting a
 * row must not look like a withdrawal, and an application that already exists must not be erasable
 * from the panel.
 *
 * The check is a pure read of the projection plus one appended event; it does not touch the browser,
 * so it cannot race with a click the way a DOM-driven action would.
 *
 * @module dsh-job-ledger/ledger/skip
 */

import { PluginError } from '../shared/errors.ts'
import { activeLease, blockingAppForJob } from './project.ts'
import type { Ledger } from './store.ts'
import type { JobStatus } from './events.ts'

/** Statuses a person may still pull out of the queue. */
const SKIPPABLE: readonly JobStatus[] = ['new', 'queued']

/** What a skip request did. */
export interface SkipResult {
  readonly jobId: string
  readonly status: 'skipped'
  /** False when the job was already skipped; the event is not appended twice. */
  readonly changed: boolean
}

/**
 * Mark one job as skipped.
 *
 * Idempotent: skipping an already-skipped job reports the state instead of appending a second event.
 * A job that already has a blocking application, or one a run is clicking right now, is refused —
 * deleting is "I do not want to apply", not "erase what happened".
 *
 * @param ledger the single writer
 * @param jobId job to skip
 * @param at event timestamp
 * @returns the resulting status
 * @throws PluginError `E_INVALID_ARGUMENT` for an unknown job, `E_ALREADY_APPLIED` for an applied or in-flight one
 */
export function skipJob(ledger: Ledger, jobId: string, at: string): SkipResult {
  const job = ledger.projection.jobs.get(jobId)
  // An unknown id is a caller mistake, not a corrupt ledger: the panel only sends ids it was given.
  if (job === undefined) throw new PluginError('E_INVALID_ARGUMENT', { what: `unknown job ${jobId}` })
  if (job.status === 'skipped') return { jobId, status: 'skipped', changed: false }
  if (blockingAppForJob(ledger.projection, jobId) !== undefined) {
    throw new PluginError('E_ALREADY_APPLIED', { jobId })
  }
  if (activeLease(ledger.projection, jobId, Date.parse(at)) !== undefined) {
    throw new PluginError('E_LEASE_HELD', { jobId })
  }
  if (!SKIPPABLE.includes(job.status)) throw new PluginError('E_ALREADY_APPLIED', { jobId })

  ledger.append({ type: 'job/status', jobId, status: 'skipped', at })
  return { jobId, status: 'skipped', changed: true }
}
