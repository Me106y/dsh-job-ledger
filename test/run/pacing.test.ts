import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import {
  DAILY_CAP,
  MAX_GAP_MS,
  MAX_REST_MS,
  MIN_GAP_MS,
  MIN_REST_MS,
  REST_EVERY,
  RUN_SIZE,
  assertCanStartRun,
  gapMs,
  remainingCapacity,
  startRunVerdict,
} from '../../src/run/pacing.ts'

/** @param values sequence returned by successive calls @returns a deterministic random source */
function seq(...values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index] ?? 0
    index += 1
    return value
  }
}

test('the caps are the hard-coded ones from the design', () => {
  assert.equal(RUN_SIZE, 10)
  assert.equal(DAILY_CAP, 30)
  assert.equal(REST_EVERY, 5)
})

test('the base gap stays inside the documented bounds', () => {
  assert.equal(gapMs(0, () => 0), MIN_GAP_MS)
  assert.equal(gapMs(0, () => 0.999_999), MAX_GAP_MS - 1)
  const sampled = gapMs(3, () => 0.5)
  assert.ok(sampled >= MIN_GAP_MS && sampled < MAX_GAP_MS)
})

test('every fifth submission adds a long rest on top of the base gap', () => {
  // random()=0 → base 30s, rest 180s.
  assert.equal(gapMs(5, seq(0, 0)), MIN_GAP_MS + MIN_REST_MS)
  // random()≈1 → base 90s, rest 300s.
  assert.equal(gapMs(10, seq(0.999_999, 0.999_999)), MAX_GAP_MS - 1 + (MAX_REST_MS - 1))
  // Not a multiple of five: base only, even when a second random value is available.
  assert.equal(gapMs(4, seq(0.5, 0.5)), Math.floor(MIN_GAP_MS + 0.5 * (MAX_GAP_MS - MIN_GAP_MS)))
})

test('remaining capacity never goes negative', () => {
  assert.equal(remainingCapacity(0), RUN_SIZE)
  assert.equal(remainingCapacity(7), 3)
  assert.equal(remainingCapacity(12), 0)
})

test('a run cannot start while another is active', () => {
  const refusal = startRunVerdict({ ids: ['j_1'], todaySubmitted: 0, activeRun: true })
  assert.ok(refusal instanceof PluginError)
  assert.equal(refusal.code, 'E_RUN_ACTIVE')
})

test('the id count must be between one and the run size', () => {
  const empty = startRunVerdict({ ids: [], todaySubmitted: 0, activeRun: false })
  assert.equal(empty?.code, 'E_INVALID_ARGUMENT')
  assert.match(empty?.message ?? '', /1–10/)

  const tooMany = startRunVerdict({
    ids: Array.from({ length: RUN_SIZE + 1 }, (_, index) => `j_${String(index)}`),
    todaySubmitted: 0,
    activeRun: false,
  })
  assert.equal(tooMany?.code, 'E_INVALID_ARGUMENT')
})

test('a batch that would cross the daily cap is refused whole, not trimmed', () => {
  assert.equal(
    startRunVerdict({ ids: ['a', 'b', 'c', 'd', 'e'], todaySubmitted: 25, activeRun: false }),
    undefined,
  )
  const refusal = startRunVerdict({
    ids: ['a', 'b', 'c', 'd', 'e', 'f'],
    todaySubmitted: 25,
    activeRun: false,
  })
  assert.equal(refusal?.code, 'E_DAILY_QUOTA')
})

test('an exhausted day refuses even a single job', () => {
  assert.equal(
    startRunVerdict({ ids: ['j_1'], todaySubmitted: DAILY_CAP, activeRun: false })?.code,
    'E_DAILY_QUOTA',
  )
})

test('assertCanStartRun throws the coded refusal', () => {
  assert.throws(
    () => assertCanStartRun({ ids: [], todaySubmitted: 0, activeRun: false }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_INVALID_ARGUMENT')
      return true
    },
  )
  assert.doesNotThrow(() =>
    assertCanStartRun({ ids: ['j_1'], todaySubmitted: 0, activeRun: false }),
  )
})
