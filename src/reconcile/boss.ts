/**
 * Reconciliation: what the platform says versus what the ledger says (PRD §5.7, TECH §10).
 *
 * The principle in one sentence: **the platform is only trusted to answer "was it sent?"**. It knows
 * nothing about replies, interviews or rejections, so reconciliation may add a `submitted` and may
 * flag a mismatch — it may never rewrite an outcome.
 *
 * Discrepancies are returned rather than stored. The locked event schema has exactly one
 * `reconcile/summary`, and inventing an event type for each row would be a schema change for a
 * diagnostic list. Callers show the list; the counts are what persist.
 *
 * @module dsh-job-ledger/reconcile/boss
 */

import { randomUUID } from 'node:crypto'

import { fingerprint } from '../dedupe/fingerprint.ts'
import { normalizeCity, normalizeCompany, normalizeTitle } from '../dedupe/normalize.ts'
import type { AppSource, Application, Job } from '../ledger/events.ts'
import type { Projection } from '../ledger/project.ts'
import { blockingAppForJob } from '../ledger/project.ts'
import type { Ledger } from '../ledger/store.ts'
import type { DeliveredRow } from './parse.ts'

/** A ledger application the platform does not know about. */
export interface Discrepancy {
  readonly jobId: string
  readonly company: string
  readonly title: string
  readonly city: string
  readonly state: string
}

/** What one reconciliation pass did. */
export interface ReconcileReport {
  readonly matched: number
  readonly backfilled: number
  readonly discrepancies: readonly Discrepancy[]
  /** True when only part of the platform history was read; discrepancies may be false positives. */
  readonly partial: boolean
}

/** Knobs for the pass. */
export interface ReconcileOptions {
  readonly now?: number | undefined
  readonly newId?: (() => string) | undefined
  /** `backfill` writes `reconcile-backfill`, which the report layer excludes from the funnel. */
  readonly source?: AppSource | undefined
  readonly partial?: boolean | undefined
}

/**
 * @param value platform timestamp @param fallback used when it cannot be parsed @returns ISO time
 */
function toIso(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

/**
 * Find the ledger job a platform row refers to.
 *
 * @param projection ledger state
 * @param row platform row
 * @returns the job, when the identity matches by platform id or by fingerprint
 */
function matchJob(projection: Projection, row: DeliveredRow): Job | undefined {
  const byKey = projection.byKey.get(`boss:${row.externalId}`)
  if (byKey !== undefined) return projection.jobs.get(byKey)

  const key = fingerprint(
    normalizeCompany(row.company),
    normalizeTitle(row.title),
    normalizeCity(row.city),
  )
  for (const jobId of projection.byFingerprint.get(key) ?? []) {
    const job = projection.jobs.get(jobId)
    if (job !== undefined) return job
  }
  return undefined
}

/**
 * Reconcile one batch of platform rows.
 *
 * @param ledger the single writer
 * @param rows rows the platform reported
 * @param options clock, id factory, source
 * @returns counts plus the discrepancy list
 */
export function reconcile(
  ledger: Ledger,
  rows: readonly DeliveredRow[],
  options: ReconcileOptions = {},
): ReconcileReport {
  const now = options.now ?? Date.now()
  const at = new Date(now).toISOString()
  const newId = options.newId ?? ((): string => `j_${randomUUID()}`)
  const newAppId = (): string => `a_${randomUUID()}`
  const source: AppSource = options.source ?? 'reconcile'

  let matched = 0
  let backfilled = 0
  const seen = new Set<string>()

  for (const row of rows) {
    const existing = matchJob(ledger.projection, row)

    if (existing !== undefined && blockingAppForJob(ledger.projection, existing.id) !== undefined) {
      // We already know this application; nothing to add and nothing to rewrite.
      matched += 1
      seen.add(existing.id)
      continue
    }

    const job = existing ?? createJob(ledger, row, { at, newId, source })
    ledger.append({
      type: 'app/create',
      app: createBackfilledApp(newAppId(), job.id, source, toIso(row.at, at)),
      at,
    })
    backfilled += 1
    seen.add(job.id)
  }

  const discrepancies = findDiscrepancies(ledger.projection, seen)

  ledger.append({
    type: 'reconcile/summary',
    matched,
    backfilled,
    discrepancies: discrepancies.length,
    at,
  })

  return {
    matched,
    backfilled,
    discrepancies,
    partial: options.partial ?? false,
  }
}

/**
 * @param ledger writer @param row platform row @param context clock, ids, source @returns the job
 */
function createJob(
  ledger: Ledger,
  row: DeliveredRow,
  context: { at: string; newId: () => string; source: AppSource },
): Job {
  const companyNorm = normalizeCompany(row.company)
  const titleNorm = normalizeTitle(row.title)
  const cityNorm = normalizeCity(row.city)
  const job: Job = {
    id: context.newId(),
    platform: 'boss',
    externalId: row.externalId,
    url: `https://www.zhipin.com/job_detail/${encodeURIComponent(row.externalId)}.html`,
    title: row.title,
    company: row.company,
    companyNorm,
    titleNorm,
    city: row.city,
    cityNorm,
    jdHash: '',
    fingerprint: fingerprint(companyNorm, titleNorm, cityNorm),
    firstSeenAt: toIso(row.at, context.at),
    status: 'new',
    source: 'reconcile',
  }
  ledger.append({ type: 'job/add', job, at: context.at })
  return job
}

/**
 * @param id application id @param jobId job @param source record source @param createdAt platform time
 * @returns the application to append
 */
function createBackfilledApp(
  id: string,
  jobId: string,
  source: AppSource,
  createdAt: string,
): Application {
  return {
    id,
    jobId,
    state: 'submitted',
    source,
    // The platform does not tell us which resume went out; pretending otherwise would poison
    // attribution later.
    resumeId: 'unknown',
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Ledger applications the platform did not report.
 *
 * Only applications we actually sent (`source: 'applied'`) are compared: rows written by a previous
 * reconciliation came from this very list, so their absence usually means the list was truncated.
 *
 * @param projection ledger state @param seen jobs the platform reported @returns discrepancies
 */
function findDiscrepancies(projection: Projection, seen: ReadonlySet<string>): Discrepancy[] {
  const found: Discrepancy[] = []
  for (const app of projection.apps.values()) {
    if (app.state !== 'submitted' && app.state !== 'uncertain') continue
    if (app.source !== 'applied') continue
    if (seen.has(app.jobId)) continue
    const job = projection.jobs.get(app.jobId)
    if (job === undefined) continue
    found.push({
      jobId: job.id,
      company: job.company,
      title: job.title,
      city: job.city,
      state: app.state,
    })
  }
  return found
}
