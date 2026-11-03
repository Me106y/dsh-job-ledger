/**
 * Pacing between applications (TECH §9.3).
 *
 * The intervals exist for one reason: the run should look like a person working through a list, not
 * a loop. They are also the cheapest safety measure the project has, which is why the caps are
 * hard-coded — a config file must not be able to raise how many strangers a bad afternoon reaches.
 *
 * Randomness is injected so tests can pin an interval without freezing time.
 *
 * @module dsh-job-ledger/run/pacing
 */

import { PluginError } from '../shared/errors.ts'
import { LIMITS } from '../shared/profile.ts'

/** Applications per run. Written into the code, shown read-only (TECH §9.3). */
export const RUN_SIZE = LIMITS.runSize

/** Applications per day. Written into the code, shown read-only (TECH §9.3). */
export const DAILY_CAP = LIMITS.daily

/** Shortest gap between two applications. */
export const MIN_GAP_MS = 30_000

/** Longest base gap between two applications. */
export const MAX_GAP_MS = 90_000

/** Extra rest after every {@link REST_EVERY} confirmed submissions. */
export const REST_EVERY = 5

/** Shortest long rest. */
export const MIN_REST_MS = 180_000

/** Longest long rest. */
export const MAX_REST_MS = 300_000

/**
 * @param min inclusive lower bound
 * @param max exclusive upper bound
 * @param random source in [0, 1)
 * @returns an integer in [min, max)
 */
function uniform(min: number, max: number, random: () => number): number {
  return Math.floor(min + random() * (max - min))
}

/**
 * Gap to wait before the next application.
 *
 * @param submittedThisRun confirmed submissions so far in this run
 * @param random randomness source, injected for tests
 * @returns milliseconds to wait
 */
export function gapMs(submittedThisRun: number, random: () => number = Math.random): number {
  const base = uniform(MIN_GAP_MS, MAX_GAP_MS, random)
  if (submittedThisRun > 0 && submittedThisRun % REST_EVERY === 0) {
    return base + uniform(MIN_REST_MS, MAX_REST_MS, random)
  }
  return base
}

/**
 * @param submittedThisRun confirmed submissions so far @returns how many more may be attempted
 */
export function remainingCapacity(submittedThisRun: number): number {
  return Math.max(0, RUN_SIZE - submittedThisRun)
}

/** Everything the guard needs to know. */
export interface StartRunInput {
  readonly ids: readonly string[]
  /** Confirmed submissions today, across runs. */
  readonly todaySubmitted: number
  readonly activeRun: boolean
}

/**
 * Decide whether a run may start.
 *
 * Note the strictness on quota: a batch that would cross the daily cap is refused whole rather than
 * trimmed. Trimming would apply to some of the jobs the user selected and silently not others,
 * which is harder to explain than "you have three left today".
 *
 * @param input what the caller wants to do
 * @returns the coded refusal, or `undefined` when the run may start
 */
export function startRunVerdict(input: StartRunInput): PluginError | undefined {
  if (input.activeRun) {
    return new PluginError('E_RUN_ACTIVE')
  }
  if (input.ids.length === 0 || input.ids.length > RUN_SIZE) {
    return new PluginError('E_INVALID_ARGUMENT', {
      what: `需要 1–${String(RUN_SIZE)} 个岗位，收到 ${String(input.ids.length)} 个`,
    })
  }
  if (input.todaySubmitted + input.ids.length > DAILY_CAP) {
    return new PluginError('E_DAILY_QUOTA')
  }
  return undefined
}

/**
 * Refuse a start the way the run layer must: by throwing a coded error.
 *
 * @param input what the caller wants to do
 * @throws PluginError with the refusal's code
 */
export function assertCanStartRun(input: StartRunInput): void {
  const refusal = startRunVerdict(input)
  if (refusal !== undefined) throw refusal
}
