import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import {
  APP_STATES,
  APP_TRANSITIONS,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/ledger/states.ts'
import type { AppState } from '../../src/ledger/events.ts'

test('APP_STATES lists every state exactly once', () => {
  assert.equal(new Set(APP_STATES).size, APP_STATES.length)
  assert.deepEqual([...APP_STATES].sort(), Object.keys(APP_TRANSITIONS).sort())
})

test('terminal states have no outgoing transitions', () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(APP_TRANSITIONS[state], [], `${state} must be final`)
    assert.equal(isTerminal(state), true)
  }
  for (const state of APP_STATES.filter((item) => !TERMINAL_STATES.includes(item))) {
    assert.equal(isTerminal(state), false)
  }
})

test('every transition target is a known state', () => {
  for (const [from, targets] of Object.entries(APP_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(APP_STATES.includes(to), `${from} -> ${to} targets an unknown state`)
    }
  }
})

test('the table has exactly 21 legal edges', () => {
  const edges = Object.values(APP_TRANSITIONS).reduce((sum, targets) => sum + targets.length, 0)
  // Widening this number is a product decision, not a refactor. The count is asserted so that a
  // careless extra edge shows up as a failing test instead of a silent behaviour change.
  assert.equal(edges, 21)
})

test('submitted is a one-way door for automation', () => {
  for (const state of ['queued', 'applying', 'uncertain', 'failed'] as AppState[]) {
    assert.equal(canTransition('submitted', state), false, `submitted must not return to ${state}`)
  }
})

test('uncertain can never go back to queued', () => {
  // The absence of this edge is what makes "never auto-retry" structural rather than a promise.
  assert.equal(canTransition('uncertain', 'queued'), false)
  assert.equal(canTransition('uncertain', 'applying'), false)
})

test('a failed application can be retried by a human', () => {
  assert.equal(canTransition('failed', 'queued'), true)
})

test('assertTransition throws a coded error listing what was allowed', () => {
  assert.throws(
    () => assertTransition('submitted', 'queued'),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_ILLEGAL_TRANSITION')
      assert.equal(error.values?.allowed, 'replied,rejected,withdrawn')
      return true
    },
  )
})

test('assertTransition accepts every edge in the table', () => {
  for (const [from, targets] of Object.entries(APP_TRANSITIONS)) {
    for (const to of targets) {
      assert.doesNotThrow(() => assertTransition(from as AppState, to))
    }
  }
})
