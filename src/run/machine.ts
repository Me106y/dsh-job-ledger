/**
 * Run state machine (TECH §9.1, PRD §5.10).
 *
 * A run is the long-lived "apply to these N jobs" task. Keeping it a pure function means the panel,
 * the tools and the replay path all agree on what `halted` means without sharing mutable state.
 *
 * Two asymmetries are deliberate:
 * - `halted` is terminal for *that run*. The remaining jobs go back to `queued` and a later run
 *   picks them up under a fresh authorization, which is what stops a circuit breaker from being
 *   silently retried by the same run id (PRD §5.10).
 * - `paused` is the only state with a `resume` action, and resume requires a new `run/start`
 *   carrying a fresh `grantedBy` — re-authorizing is cheaper than trusting a stale grant.
 *
 * @module dsh-job-ledger/run/machine
 */

import { PluginError } from '../shared/errors.ts'

/** Where a run is in its lifecycle. */
export type RunState = 'queued' | 'running' | 'done' | 'done-with-errors' | 'halted' | 'paused'

/** What can happen to a run. */
export type RunAction = 'start' | 'resume' | 'pause' | 'halt' | 'finish'

/** What a finished run accomplished. Nothing here is a judgement — counts only. */
export interface RunOutcome {
  readonly submitted: number
  readonly uncertain: number
  readonly failed: number
}

/**
 * Legal moves. `finish` has two possible targets, resolved by {@link transition} from the outcome,
 * so it maps to the happy-path target here and to `done-with-errors` when counts are non-zero.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, Partial<Record<RunAction, RunState>>>> = {
  queued: { start: 'running' },
  running: { pause: 'paused', halt: 'halted', finish: 'done' },
  paused: { resume: 'running', halt: 'halted', finish: 'done' },
  done: {},
  'done-with-errors': {},
  halted: {},
}

/** @param state run state @returns whether the run is currently holding the single-run lock */
export function isRunActive(state: RunState): boolean {
  return state === 'running' || state === 'paused'
}

/** @param state run state @returns whether the run can no longer move */
export function isRunFinished(state: RunState): boolean {
  return state === 'done' || state === 'done-with-errors' || state === 'halted'
}

/**
 * Take one step in the run state machine.
 *
 * @param state current state
 * @param action requested action
 * @param outcome required for `finish`; decides between `done` and `done-with-errors`
 * @returns the next state
 * @throws PluginError `E_RUN_ACTIVE` when a second run tries to start, `E_ILLEGAL_TRANSITION` otherwise
 */
export function transition(state: RunState, action: RunAction, outcome?: RunOutcome): RunState {
  // A paused run still owns the single-run lock, so starting "again" is a second run, not a
  // resume: resume is its own action and needs a fresh authorization.
  if (action === 'start' && isRunActive(state)) {
    throw new PluginError('E_RUN_ACTIVE', { run: state })
  }
  const target = RUN_TRANSITIONS[state][action]
  if (target === undefined) {
    throw new PluginError('E_ILLEGAL_TRANSITION', {
      from: state,
      to: action,
      allowed: Object.keys(RUN_TRANSITIONS[state]).join(',') || '(terminal)',
    })
  }
  if (action !== 'finish') return target
  const dirty = (outcome?.failed ?? 0) + (outcome?.uncertain ?? 0) > 0
  return dirty ? 'done-with-errors' : target
}
