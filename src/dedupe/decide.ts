/**
 * Three-level duplicate decision (PRD §5.3, TECH §7.4).
 *
 * The asymmetry is the design: a missed duplicate costs one extra application, a false duplicate
 * costs the opportunity permanently and silently. So every check errs toward "show it to the
 * user", and the *order* below matters — dedupe first, filter second, so the reason the user sees
 * is the real one.
 *
 * This function is pure and deterministic. The model may explain a verdict but never produce one:
 * a model in this path would make the same inputs produce different outcomes on different days,
 * which is exactly what makes duplicates unauditable.
 *
 * @module dsh-job-ledger/dedupe/decide
 */

import type { Platform } from '../ledger/events.ts'
import type { Projection } from '../ledger/project.ts'
import { attemptsFor, jobsInWindow } from '../ledger/project.ts'
import { hardFilter } from '../filter/rules.ts'
import type { FilterReason } from '../filter/rules.ts'
import { fingerprint } from './fingerprint.ts'
import { hammingDistance, hasJd } from './simhash.ts'

/** Window for "same company + role + city" (PRD §5.3). */
export const FINGERPRINT_WINDOW_DAYS = 45

/** Window for SimHash comparison. Same window as the fingerprint check, for one mental model. */
export const SIMHASH_WINDOW_DAYS = 45

/** What we know about a candidate before it enters the ledger. */
export interface Candidate {
  readonly platform: Platform
  readonly externalId: string
  readonly company: string
  readonly title: string
  readonly city: string
  readonly companyNorm: string
  readonly titleNorm: string
  readonly cityNorm: string
  /** 64-bit SimHash as hex; `''` when the source gave no JD. */
  readonly jdHash: string
  readonly jdText?: string
  readonly salaryMin?: number
}

/** Every verdict, with the reason recorded next to it. */
export type DecisionReason =
  | 'same-posting'
  | 'same-role-company'
  | 'cross-source-same-jd'
  | 'cooldown'
  | 'same-title-different-jd'
  | FilterReason
  | 'new'

/** The verdict. `duplicateOf` is present whenever there is a specific job to point at. */
export interface Decision {
  readonly kind: 'duplicate' | 'suspect' | 'filtered' | 'new'
  readonly reason: DecisionReason
  readonly duplicateOf?: string
  /** Human-readable extra context, e.g. the keyword that matched. */
  readonly detail?: string
}

/** @param days window length @returns milliseconds */
function days(value: number): number {
  return value * 86_400_000
}

/**
 * Decide what to do with a candidate.
 *
 * @param candidate normalized fields plus SimHash
 * @param projection current ledger state
 * @param now epoch ms (injected so tests are deterministic)
 * @returns duplicate / suspect / filtered / new, with a reason
 */
export function decide(candidate: Candidate, projection: Projection, now: number): Decision {
  const { profile } = projection

  const key = `${candidate.platform}:${candidate.externalId}`
  const samePosting = projection.byKey.get(key)
  if (samePosting !== undefined) {
    return { kind: 'duplicate', reason: 'same-posting', duplicateOf: samePosting }
  }

  const candidateFingerprint = fingerprint(
    candidate.companyNorm,
    candidate.titleNorm,
    candidate.cityNorm,
  )
  for (const jobId of projection.byFingerprint.get(candidateFingerprint) ?? []) {
    const job = projection.jobs.get(jobId)
    if (job === undefined) continue
    if (now - Date.parse(job.firstSeenAt) < days(FINGERPRINT_WINDOW_DAYS)) {
      return { kind: 'duplicate', reason: 'same-role-company', duplicateOf: job.id }
    }
  }

  // Near-identical JD text counts as the same posting, but only inside one city. Two guards
  // keep this from becoming a false positive:
  // - the city must match (PRD §5.3 hard rule: 城市不同不判重);
  // - the same company with a different title is always a new job (PRD §5.3 hard rule), so it is
  //   skipped before the JD test can fire, even when the JD text is identical.
  if (hasJd(candidate.jdHash)) {
    for (const job of jobsInWindow(projection, now, SIMHASH_WINDOW_DAYS)) {
      if (!hasJd(job.jdHash)) continue
      if (job.companyNorm === candidate.companyNorm && job.titleNorm !== candidate.titleNorm) {
        continue
      }
      const distance = hammingDistance(job.jdHash, candidate.jdHash)
      if (distance > profile.dedupe.simhashDistance) continue
      if (job.cityNorm === candidate.cityNorm) {
        return { kind: 'duplicate', reason: 'cross-source-same-jd', duplicateOf: job.id }
      }
    }
  }

  for (const app of attemptsFor(projection, candidate.companyNorm, candidate.titleNorm)) {
    if (now - Date.parse(app.updatedAt) < days(profile.dedupe.cooldownDays)) {
      return { kind: 'duplicate', reason: 'cooldown', duplicateOf: app.jobId }
    }
  }

  // Same company + title + city, but first seen outside the 45-day window: possibly the same
  // posting re-listed. A human decides; nothing is dropped automatically.
  const previousJobId = (projection.byFingerprint.get(candidateFingerprint) ?? [])[0]
  if (previousJobId !== undefined) {
    return { kind: 'suspect', reason: 'same-title-different-jd', duplicateOf: previousJobId }
  }

  const hit = hardFilter(
    {
      companyNorm: candidate.companyNorm,
      title: candidate.title,
      cityNorm: candidate.cityNorm,
      ...(candidate.jdText === undefined ? {} : { jdText: candidate.jdText }),
      ...(candidate.salaryMin === undefined ? {} : { salaryMin: candidate.salaryMin }),
    },
    profile,
  )
  if (hit !== undefined) {
    return { kind: 'filtered', reason: hit.reason, detail: hit.detail }
  }

  return { kind: 'new', reason: 'new' }
}
