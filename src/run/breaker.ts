/**
 * Circuit breaker (TECH §9.4).
 *
 * The breaker's job is to stop the **whole run** on the first sign that the account is at risk.
 * Skipping the current job and continuing would keep hammering a wall that just said "stop", which
 * is how a rate limit becomes a ban.
 *
 * It is a pure fold over outcomes so the decision can be tested without a browser: the executor
 * produces outcomes, this decides whether the run survives them.
 *
 * @module dsh-job-ledger/run/breaker
 */

import type { HaltReason } from '../ledger/events.ts'

/** What one application attempt produced, as far as the breaker cares. */
export type AttemptOutcome =
  | { readonly kind: 'submitted' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'uncertain' }
  /** Something already mapped to a reason: captcha, business code, CDP loss, ledger failure. */
  | { readonly kind: 'halt'; readonly reason: HaltReason }

/** How many failures in a row are tolerated before the run stops. */
export const FAILURE_LIMIT = 2

/** Breaker memory. */
export interface BreakerState {
  readonly consecutiveFailures: number
}

/** The breaker's answer. `reason` is present exactly when `halt` is true. */
export type BreakerDecision =
  | { readonly halt: false; readonly state: BreakerState }
  | { readonly halt: true; readonly reason: HaltReason; readonly state: BreakerState }

/** @returns a breaker with no failures remembered */
export function createBreaker(): BreakerState {
  return { consecutiveFailures: 0 }
}

/**
 * Fold one outcome into the breaker.
 *
 * @param state breaker memory
 * @param outcome what the attempt produced
 * @returns whether to stop the run, and the reason to record
 */
export function observe(state: BreakerState, outcome: AttemptOutcome): BreakerDecision {
  if (outcome.kind === 'submitted') return { halt: false, state: createBreaker() }

  if (outcome.kind === 'uncertain') {
    // A click that may have landed is not a failure to retry; it is a reason to stop and ask.
    return { halt: true, reason: 'uncertain', state }
  }

  if (outcome.kind === 'halt') {
    return { halt: true, reason: outcome.reason, state }
  }

  const consecutiveFailures = state.consecutiveFailures + 1
  if (consecutiveFailures >= FAILURE_LIMIT) {
    return { halt: true, reason: 'consecutive-failures', state: { consecutiveFailures } }
  }
  return { halt: false, state: { consecutiveFailures } }
}
