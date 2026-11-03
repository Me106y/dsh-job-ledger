import assert from 'node:assert/strict'
import test from 'node:test'

import { LEASE_TTL_MS, claimVerdict, leaseExpiry } from '../../src/run/lease.ts'
import { makeApp } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

test('a free job may be claimed', () => {
  assert.deepEqual(claimVerdict({ now: NOW }), { ok: true })
})

test('an application that already went out blocks the claim', () => {
  assert.deepEqual(claimVerdict({ blockingApp: makeApp('j_1', 'submitted'), now: NOW }), {
    ok: false,
    code: 'E_ALREADY_APPLIED',
  })
})

test('a live lease blocks the claim and names its holder', () => {
  const verdict = claimVerdict({
    lease: { jobId: 'j_1', owner: 'run-1', expiresAt: new Date(NOW + 1_000).toISOString() },
    now: NOW,
  })
  assert.deepEqual(verdict, { ok: false, code: 'E_LEASE_HELD', holder: 'run-1' })
})

test('the boundary tick still belongs to the holder', () => {
  // TECH §6.5: only `expiresAt < now` frees the job.
  const atBoundary = claimVerdict({
    lease: { jobId: 'j_1', owner: 'run-1', expiresAt: new Date(NOW).toISOString() },
    now: NOW,
  })
  assert.equal(atBoundary.ok, false)
})

test('an expired lease frees the job', () => {
  const verdict = claimVerdict({
    lease: { jobId: 'j_1', owner: 'run-1', expiresAt: new Date(NOW - 1).toISOString() },
    now: NOW,
  })
  assert.deepEqual(verdict, { ok: true })
})

test('the application check wins over the lease check', () => {
  const verdict = claimVerdict({
    blockingApp: makeApp('j_1', 'uncertain'),
    lease: { jobId: 'j_1', owner: 'run-1', expiresAt: new Date(NOW + 1_000).toISOString() },
    now: NOW,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.code : '', 'E_ALREADY_APPLIED')
})

test('a lease taken now expires after the documented TTL', () => {
  assert.equal(leaseExpiry(NOW), new Date(NOW + LEASE_TTL_MS).toISOString())
  assert.equal(LEASE_TTL_MS, 10 * 60_000)
})
