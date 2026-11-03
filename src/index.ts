/**
 * Plugin entry (host side).
 *
 * P0 (ledger core) is in: event log, projection, three-level dedupe, both state machines, leases and
 * the report. Still skeleton: the Chrome/CDP layer, the tools, the host API and the panel — those
 * land at P1 onward (docs/PRD.md §12). `apply()` stays a stub until the store is wired in P1, so the
 * plugin can be installed without pretending to do more than it does.
 *
 * @module dsh-job-ledger
 */

export { ERROR_MESSAGES, failure, isErrorCode, isFatal, isRetryable, userMessage, PluginError } from './shared/errors.ts'
export type { ErrorCode, LedgerFailure } from './shared/errors.ts'

export { DEFAULT_PROFILE, LIMITS, mergeProfile } from './shared/profile.ts'
export type { Profile, ProfilePatch, ResumeExposure, TargetRules } from './shared/profile.ts'

export { EVENT_TYPES, EVENT_VERSION, isEventType } from './ledger/events.ts'
export type {
  AppSource,
  AppState,
  Application,
  EventInput,
  EventType,
  GrantedBy,
  HaltReason,
  Job,
  JobSource,
  JobStatus,
  LedgerEvent,
  Lease,
  Platform,
  RunSummary,
} from './ledger/events.ts'

export {
  APP_STATES,
  APP_TRANSITIONS,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  isTerminal,
} from './ledger/states.ts'
export {
  ATTEMPTED_STATES,
  BLOCKING_STATES,
  activeLease,
  appsInState,
  applyEvent,
  attemptsFor,
  blockingAppForJob,
  blocksReapply,
  companyTitleKey,
  countsAsAttempt,
  createProjection,
  dayOf,
  jobsInWindow,
  requireJob,
} from './ledger/project.ts'
export type {
  DecisionRecord,
  IngestRecord,
  Projection,
  ReconcileRecord,
  RunRecord,
} from './ledger/project.ts'

export { LEDGER_FILE, MAX_LINE_BYTES, Ledger, replay } from './ledger/store.ts'
export type { OpenReport, ReplayResult } from './ledger/store.ts'

export { fingerprint } from './dedupe/fingerprint.ts'
export { NO_JD_DISTANCE, hammingDistance, hasJd, simhash, tokenize } from './dedupe/simhash.ts'
export {
  fold,
  normalizeCity,
  normalizeCompany,
  normalizeTitle,
  normalizeUrl,
} from './dedupe/normalize.ts'
export { FINGERPRINT_WINDOW_DAYS, SIMHASH_WINDOW_DAYS, decide } from './dedupe/decide.ts'
export type { Candidate, Decision, DecisionReason } from './dedupe/decide.ts'

export { hardFilter } from './filter/rules.ts'
export type { FilterHit, FilterInput, FilterReason } from './filter/rules.ts'

export { RUN_TRANSITIONS, isRunActive, isRunFinished, transition } from './run/machine.ts'
export type { RunAction, RunOutcome, RunState } from './run/machine.ts'
export { LEASE_TTL_MS, claimVerdict, leaseExpiry } from './run/lease.ts'
export type { ClaimInput, ClaimVerdict } from './run/lease.ts'

export { buildReport, reportMarkdown } from './report/build.ts'
export type { Funnel, Report, SourceRow, WeekRow } from './report/build.ts'

/** Cordis plugin name. */
export const name = 'job-ledger'

/** Services this plugin needs. Empty until P1/P5 wire the ledger and the panel. */
export const inject: readonly string[] = []

/** The slice of the cordis context this skeleton uses. */
export interface PluginContext {
  readonly logger: {
    info(message: string): void
    warn(message: string): void
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx host context
 */
export function apply(ctx: PluginContext): void {
  ctx.logger.info('dsh-job-ledger: P0 ledger core built; Chrome/CDP lands at P1')
}
