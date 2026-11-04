/**
 * Hard filter: the deterministic part of "is this worth applying to" (TECH §8.1).
 *
 * It runs *after* dedupe, never before. If it ran first, a posting that was already applied to
 * would be reported as "doesn't match your filters", and the user would tighten filters that were
 * never the problem (TECH §7.4).
 *
 * Every rejection carries a reason, because a silently dropped job is indistinguishable from a job
 * that never existed — and the user must be able to pull it back (PRD §5.4).
 *
 * @module dsh-job-ledger/filter/rules
 */

import type { Profile } from '../shared/profile.ts'
import { fold, normalizeCity, normalizeCompany } from '../dedupe/normalize.ts'

/** Why the hard filter rejected a candidate. */
export type FilterReason =
  | 'company-blacklist'
  | 'excluded-keyword'
  | 'city-mismatch'
  | 'salary-below-floor'
  | 'job-type-mismatch'

/** The fields the filter needs. Kept structural so ingestion can pass a raw row. */
export interface FilterInput {
  readonly companyNorm: string
  readonly title: string
  readonly cityNorm: string
  readonly jdText?: string
  readonly salaryMin?: number
}

/** A rejection, with the value that triggered it so the UI can show "被『外包』挡住". */
export interface FilterHit {
  readonly reason: FilterReason
  readonly detail: string
}

/**
 * Evaluate the hard filter.
 *
 * @param input candidate fields
 * @param profile user rules
 * @returns the first rejection, or `undefined` when the candidate passes
 */
export function hardFilter(input: FilterInput, profile: Profile): FilterHit | undefined {
  const blacklist = profile.target.companyBlacklist.map(normalizeCompany)
  if (blacklist.includes(input.companyNorm)) {
    return { reason: 'company-blacklist', detail: input.companyNorm }
  }

  const haystack = fold(`${input.title}\n${input.jdText ?? ''}`)
  for (const keyword of profile.target.excludeKeywords) {
    const needle = fold(keyword)
    if (needle !== '' && haystack.includes(needle)) {
      return { reason: 'excluded-keyword', detail: keyword }
    }
  }

  // 求职类型 is decided from the posting's own words: the platform's filter is a separate request
  // we cannot set reliably yet, and guessing a URL parameter would silently search the wrong pool.
  const wanted = profile.target.jobType
  if (wanted !== 'all') {
    const intern = /实习|intern/.test(haystack)
    const campus = /校招|应届|校园|春招|秋招|管培/.test(haystack)
    const matches = wanted === 'intern' ? intern : wanted === 'campus' ? campus : !intern && !campus
    if (!matches) return { reason: 'job-type-mismatch', detail: wanted }
  }

  const cities = profile.target.cities.map(normalizeCity)
  if (cities.length > 0 && input.cityNorm !== 'remote' && !cities.includes(input.cityNorm)) {
    return { reason: 'city-mismatch', detail: input.cityNorm }
  }

  const floor = profile.target.salaryMin
  if (floor > 0 && input.salaryMin !== undefined && input.salaryMin < floor) {
    return { reason: 'salary-below-floor', detail: String(input.salaryMin) }
  }

  return undefined
}
