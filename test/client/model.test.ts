import assert from 'node:assert/strict'
import test from 'node:test'

import type { OverviewView, QueueRowView, RunView } from '../../src/api/contract.ts'
import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  REFILL_DEBOUNCE_MS,
  isStale,
  pollInterval,
  pruneSelection,
  remainingQuota,
  rowSubtitle,
  runLabel,
  toggleSelection,
  withoutRows,
} from '../../src/client/model.ts'

const IDLE: RunView = { state: 'idle', total: 0, done: 0 }
const RUNNING: RunView = { state: 'running', total: 5, done: 1 }

/** @param overrides row fields @returns a queue row */
function row(overrides: Partial<QueueRowView> = {}): QueueRowView {
  return {
    jobId: 'j_1',
    title: '后端工程师',
    company: '字节跳动',
    city: '深圳',
    salary: '25-35K',
    reason: 'new',
    decision: 'new',
    firstSeenAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  }
}

test('polling is fast while a run is active and slow when it is not', () => {
  assert.equal(pollInterval(RUNNING), POLL_ACTIVE_MS)
  assert.equal(pollInterval(IDLE), POLL_IDLE_MS)
  assert.equal(pollInterval(undefined), POLL_IDLE_MS)
  assert.equal(pollInterval({ ...RUNNING, state: 'queued' }), POLL_ACTIVE_MS)
  assert.equal(pollInterval({ ...RUNNING, state: 'halted' }), POLL_IDLE_MS)
})

test('an unchanged revision is not worth a re-render', () => {
  assert.equal(isStale(undefined, 1), true)
  assert.equal(isStale(3, 3), false)
  assert.equal(isStale(3, 4), true)
})

test('the row subtitle drops empty parts instead of leaving separators', () => {
  assert.equal(rowSubtitle(row()), '字节跳动 · 深圳 · 25-35K')
  assert.equal(rowSubtitle(row({ salary: '', city: '' })), '字节跳动')
})

test('selection survives a refresh only for rows that still exist', () => {
  const selected = new Set(['j_1', 'j_2'])
  assert.deepEqual([...pruneSelection([row()], selected)], ['j_1'])
})

test('toggling adds then removes', () => {
  const once = toggleSelection(new Set(), 'j_1')
  assert.deepEqual([...once], ['j_1'])
  assert.deepEqual([...toggleSelection(once, 'j_1')], [])
})

test('the quota remainder never goes negative', () => {
  const view: OverviewView = {
    revision: 1,
    today: { submitted: 31, quota: 30 },
    uncertain: 0,
    discrepancies: 0,
    repliedYesterday: 0,
    run: IDLE,
  }
  assert.equal(remainingQuota(view), 0)
  assert.equal(remainingQuota({ ...view, today: { submitted: 4, quota: 30 } }), 26)
})

test('every run state has a label', () => {
  for (const state of ['idle', 'queued', 'running', 'paused', 'halted', 'done', 'done-with-errors'] as const) {
    assert.ok(runLabel(state).length > 0)
  }
})

test('deleted rows stay hidden until a payload catches up', () => {
  const rows = [row({ jobId: 'j_1' }), row({ jobId: 'j_2' })]

  assert.deepEqual(withoutRows(rows, new Set()).map((entry) => entry.jobId), ['j_1', 'j_2'])
  assert.deepEqual(withoutRows(rows, new Set(['j_1'])).map((entry) => entry.jobId), ['j_2'])
  // An id the payload never had changes nothing.
  assert.deepEqual(withoutRows(rows, new Set(['j_x'])).map((entry) => entry.jobId), ['j_1', 'j_2'])
  assert.ok(REFILL_DEBOUNCE_MS > 0)
})
