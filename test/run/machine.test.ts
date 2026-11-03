import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import { RUN_TRANSITIONS, isRunActive, isRunFinished, transition } from '../../src/run/machine.ts'
import type { RunAction, RunState } from '../../src/run/machine.ts'

const STATES: readonly RunState[] = [
  'queued',
  'running',
  'paused',
  'done',
  'done-with-errors',
  'halted',
]

const ACTIONS: readonly RunAction[] = ['start', 'resume', 'pause', 'halt', 'finish']

/**
 * The expected table, written out independently of the implementation. If someone edits
 * `RUN_TRANSITIONS`, this comparison is what notices.
 */
const EXPECTED: Readonly<Record<RunState, Partial<Record<RunAction, RunState>>>> = {
  queued: { start: 'running' },
  running: { pause: 'paused', halt: 'halted', finish: 'done' },
  paused: { resume: 'running', halt: 'halted', finish: 'done' },
  done: {},
  'done-with-errors': {},
  halted: {},
}

test('the transition table matches the documented matrix', () => {
  assert.deepEqual(RUN_TRANSITIONS, EXPECTED)
})

test('every state and action pair either moves or is refused', () => {
  for (const state of STATES) {
    for (const action of ACTIONS) {
      const target = EXPECTED[state][action]
      if (target === undefined) {
        assert.throws(
          () => transition(state, action),
          (error: unknown) => error instanceof PluginError,
          `${state} + ${action} should be refused`,
        )
      } else {
        assert.equal(transition(state, action), target, `${state} + ${action}`)
      }
    }
  }
})

test('starting a second run is E_RUN_ACTIVE, not a generic refusal', () => {
  // The panel and the tool both need to tell "busy" apart from "broken".
  assert.throws(
    () => transition('running', 'start'),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_RUN_ACTIVE')
      return true
    },
  )
})

test('halted is terminal: a halted run never resumes itself', () => {
  assert.throws(() => transition('halted', 'resume'), PluginError)
  assert.throws(() => transition('halted', 'start'), PluginError)
  assert.equal(isRunFinished('halted'), true)
})

test('finish reports done-with-errors when anything went wrong', () => {
  assert.equal(transition('running', 'finish', { submitted: 10, uncertain: 0, failed: 0 }), 'done')
  assert.equal(
    transition('running', 'finish', { submitted: 9, uncertain: 0, failed: 1 }),
    'done-with-errors',
  )
  assert.equal(
    transition('running', 'finish', { submitted: 9, uncertain: 1, failed: 0 }),
    'done-with-errors',
  )
})

test('finish without an outcome counts as clean', () => {
  assert.equal(transition('running', 'finish'), 'done')
})

test('a paused run is still active, a finished one is not', () => {
  assert.equal(isRunActive('running'), true)
  assert.equal(isRunActive('paused'), true)
  assert.equal(isRunActive('queued'), false)
  assert.equal(isRunFinished('done'), true)
  assert.equal(isRunFinished('done-with-errors'), true)
  for (const state of ['queued', 'running', 'paused'] as RunState[]) {
    assert.equal(isRunFinished(state), false)
  }
})
