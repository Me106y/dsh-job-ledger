import assert from 'node:assert/strict'
import test from 'node:test'

import { FAILURE_LIMIT, createBreaker, observe } from '../../src/run/breaker.ts'

test('a fresh breaker remembers nothing', () => {
  assert.deepEqual(createBreaker(), { consecutiveFailures: 0 })
  assert.equal(FAILURE_LIMIT, 2)
})

test('one failure is survivable', () => {
  const decision = observe(createBreaker(), { kind: 'failed' })
  assert.equal(decision.halt, false)
  assert.equal(decision.state.consecutiveFailures, 1)
})

test('two failures in a row stop the whole run', () => {
  const first = observe(createBreaker(), { kind: 'failed' })
  assert.equal(first.halt, false)
  if (first.halt) return

  const second = observe(first.state, { kind: 'failed' })
  assert.equal(second.halt, true)
  if (!second.halt) return
  // Not "skip this job and continue": the run stops, because the next click is the risky one.
  assert.equal(second.reason, 'consecutive-failures')
})

test('a submission resets the failure count', () => {
  const failed = observe(createBreaker(), { kind: 'failed' })
  if (failed.halt) return
  const submitted = observe(failed.state, { kind: 'submitted' })
  assert.equal(submitted.halt, false)
  assert.equal(submitted.state.consecutiveFailures, 0)

  const again = observe(submitted.state, { kind: 'failed' })
  assert.equal(again.halt, false)
})

test('uncertain halts immediately, even when nothing failed before', () => {
  const decision = observe(createBreaker(), { kind: 'uncertain' })
  assert.equal(decision.halt, true)
  if (!decision.halt) return
  assert.equal(decision.reason, 'uncertain')
})

test('a pre-mapped halt keeps its reason', () => {
  for (const reason of ['captcha', 'rate-limited', 'account-risk', 'stoken-expired', 'cdp-disconnected'] as const) {
    const decision = observe(createBreaker(), { kind: 'halt', reason })
    assert.equal(decision.halt, true)
    assert.equal(decision.halt ? decision.reason : undefined, reason)
  }
})

test('the breaker keeps counting after it has already stopped', () => {
  const first = observe(createBreaker(), { kind: 'failed' })
  if (first.halt) return assert.fail('one failure must not halt the run')

  const second = observe(first.state, { kind: 'failed' })
  if (!second.halt) return assert.fail('two failures must halt the run')

  const third = observe(second.state, { kind: 'failed' })
  assert.equal(third.halt, true)
  // The counter keeps the real number, so a resume decision has the facts, not just "halted".
  assert.equal(third.state.consecutiveFailures, 3)
})
