/**
 * The redaction layer between the browser and the model (TECH §16.2).
 *
 * It is a whitelist projection, not a blacklist: `redacted` keeps only the fields matching needs
 * and drops everything else, so a field added to the resume next year is excluded by default
 * instead of leaking by default.
 *
 * @module dsh-job-ledger/resume/redact
 */

import type { ResumeExposure } from '../shared/profile.ts'
import type { Resume } from './parse.ts'

/** A mutable copy, used only to delete from it. */
type MutableResume = { -readonly [K in keyof Resume]: Resume[K] }

/**
 * Apply the configured exposure level.
 *
 * - `redacted` (default): no name, no phone, no email. Matching never needs them, and a screen full
 *   of PII is one screenshot away from being pasted somewhere.
 * - `full`: the author's own machine only.
 *
 * @param resume structured resume
 * @param exposure configured level
 * @returns the resume as it may be shown to the model
 */
export function redactResume(resume: Resume, exposure: ResumeExposure): Resume {
  if (exposure === 'full') return resume
  const copy: MutableResume = { ...resume }
  delete copy.contact
  return copy
}
