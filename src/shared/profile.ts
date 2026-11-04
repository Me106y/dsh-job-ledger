/**
 * User profile: the filter and dedupe knobs, plus the privacy switch.
 *
 * This is the *domain* shape of the profile, not the cordis config schema. The config layer
 * (later milestone) validates YAML against `docs/TECH-DESIGN.md §14` and then reduces it to this
 * shape; the ledger stores it through `profile/set` events, which are merged, not replaced.
 *
 * `limits` is deliberately absent: run size and the daily cap are written into the code
 * (`LIMITS`) so a config file cannot raise them (TECH §9.3, PRD §5.5).
 *
 * @module dsh-job-ledger/shared/profile
 */

/** Whether resume details may reach the model verbatim. Defaults to `redacted` (PRD §7). */
export type ResumeExposure = 'redacted' | 'full'

/** Hard caps. Not configurable by design; the panel shows them read-only. */
export const LIMITS = {
  runSize: 10,
  daily: 30,
} as const

/** What the user wants to apply to. Every field is optional in spirit: empty means "no opinion". */
export interface TargetRules {
  /** Role keywords. Empty means "use the online resume's expected roles". */
  readonly roles: readonly string[]
  /** Cities. Empty means "use the expected cities". `remote` always passes. */
  readonly cities: readonly string[]
  /** Salary floor in yuan/month. `0` disables the check. */
  readonly salaryMin: number
  /** Title or JD keywords that disqualify a job. Silent drops are not allowed, so these are logged. */
  readonly excludeKeywords: readonly string[]
  /** Normalized company names that are never worth applying to. */
  readonly companyBlacklist: readonly string[]
}

/** Everything the ledger needs to evaluate a candidate. */
export interface Profile {
  readonly target: TargetRules
  readonly dedupe: {
    /** Days a "company + role" pair stays out of the queue after an application. */
    readonly cooldownDays: number
    /** SimHash Hamming distance at or below which two JDs count as the same posting. */
    readonly simhashDistance: number
  }
  readonly privacy: {
    readonly resumeExposure: ResumeExposure
  }
  readonly reconcile: {
    /** Page cap for `geekDeliverList`; backfill stops here and says so. */
    readonly maxPages: number
  }
  /** The user's own tracker sheet (PRD §5.11). Empty means the feature is off. */
  readonly tracker: {
    /** Absolute path to an `.xlsx` or `.numbers` file. */
    readonly path: string
  }
}

/** Deep partial used by `mergeProfile`: a patch may touch one leaf without restating the rest. */
export type ProfilePatch = {
  readonly [K in keyof Profile]?: Partial<Profile[K]>
}

/** Defaults from PRD §5.4 / §5.7 / TECH §14. */
export const DEFAULT_PROFILE: Profile = {
  target: {
    roles: [],
    cities: [],
    salaryMin: 0,
    excludeKeywords: ['销售', '外包', '驻场', '培训', '中介', '保险'],
    companyBlacklist: [],
  },
  dedupe: { cooldownDays: 90, simhashDistance: 3 },
  privacy: { resumeExposure: 'redacted' },
  reconcile: { maxPages: 10 },
  tracker: { path: '' },
}

/**
 * Merge a patch into a profile, section by section.
 *
 * Arrays replace rather than concatenate: "clear the blacklist" has to be expressible, and
 * concatenation would make a config edit un-undoable.
 *
 * @param base current profile
 * @param patch partial update
 * @returns a new profile; neither argument is mutated
 */
export function mergeProfile(base: Profile, patch: ProfilePatch): Profile {
  const target = { ...base.target, ...(patch.target ?? {}) }
  const dedupe = { ...base.dedupe, ...(patch.dedupe ?? {}) }
  const privacy = { ...base.privacy, ...(patch.privacy ?? {}) }
  const reconcile = { ...base.reconcile, ...(patch.reconcile ?? {}) }
  const tracker = { ...base.tracker, ...(patch.tracker ?? {}) }
  return { target, dedupe, privacy, reconcile, tracker }
}
