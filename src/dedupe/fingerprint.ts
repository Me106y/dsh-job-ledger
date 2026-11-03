/**
 * Fingerprint: the identity of a "company + role + city" across sources (TECH §7.2).
 *
 * Two postings with the same fingerprint are the same opportunity even when the platform id
 * differs — that is how the same role re-posted by three HRs, or found through both search and
 * recommendation, collapses into one.
 *
 * @module dsh-job-ledger/dedupe/fingerprint
 */

import { createHash } from 'node:crypto'

/** Truncated hash length. 16 hex chars is plenty at one user's scale and keeps lines short. */
const FINGERPRINT_LENGTH = 16

/**
 * Compute the fingerprint.
 *
 * @param companyNorm normalized company
 * @param titleNorm normalized title
 * @param cityNorm normalized city
 * @returns 16 hex chars
 */
export function fingerprint(companyNorm: string, titleNorm: string, cityNorm: string): string {
  return createHash('sha1')
    .update(`${companyNorm}\u0001${titleNorm}\u0001${cityNorm}`)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}
