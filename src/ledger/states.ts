/**
 * Application state machine (PRD §5.6).
 *
 * The transitions are a plain table, not code, because two things depend on reading them: the
 * exhaustive test matrix, and a reviewer asking "can a `submitted` application ever go back to
 * `queued`?" — the answer must be no, and it must be visible at a glance.
 *
 * Two rules shape the table:
 * - `submitted` is a point of no return for automation: nothing but the user or reconciliation
 *   moves it onward (PRD §5.6).
 * - `failed` returns to `queued` only because a human chose to retry; `uncertain` has no way back
 *   into `queued` at all, which is what makes "never auto-retry" structural rather than a promise.
 *
 * @module dsh-job-ledger/ledger/states
 */

import { PluginError } from '../shared/errors.ts'
import type { AppState } from './events.ts'

/** States with no outgoing transition. */
export const TERMINAL_STATES: readonly AppState[] = ['offer', 'rejected', 'withdrawn', 'skipped']

/** Every state, in lifecycle order. Useful for exhaustive tests and UI filters. */
export const APP_STATES: readonly AppState[] = [
  'new',
  'queued',
  'applying',
  'submitted',
  'uncertain',
  'replied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'failed',
  'skipped',
]

/**
 * The transition table. An empty array means the state is final.
 *
 * `new → skipped` covers "a human decided not to pursue it"; `queued → skipped` covers pulling it
 * back out of the queue. Neither is reachable by automation.
 */
export const APP_TRANSITIONS: Readonly<Record<AppState, readonly AppState[]>> = {
  new: ['queued', 'skipped'],
  queued: ['applying', 'skipped'],
  applying: ['submitted', 'uncertain', 'failed'],
  submitted: ['replied', 'rejected', 'withdrawn'],
  uncertain: ['submitted', 'replied', 'failed', 'withdrawn'],
  replied: ['interview', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'],
  offer: [],
  rejected: [],
  withdrawn: [],
  failed: ['queued'],
  skipped: [],
}

/** @param state application state @returns whether no transition leaves it */
export function isTerminal(state: AppState): boolean {
  return TERMINAL_STATES.includes(state)
}

/** @param from current state @param to requested state @returns whether the move is in the table */
export function canTransition(from: AppState, to: AppState): boolean {
  return APP_TRANSITIONS[from].includes(to)
}

/**
 * Apply a transition or refuse it.
 *
 * @param from current state
 * @param to requested state
 * @throws PluginError `E_ILLEGAL_TRANSITION`, carrying both states and what was allowed
 */
export function assertTransition(from: AppState, to: AppState): void {
  if (canTransition(from, to)) return
  throw new PluginError('E_ILLEGAL_TRANSITION', {
    from,
    to,
    allowed: APP_TRANSITIONS[from].join(',') || '(terminal)',
  })
}
