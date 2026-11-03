import assert from 'node:assert/strict'
import test from 'node:test'

import { haltReasonForFailure, judgeAttempt } from '../../src/run/attempt.ts'

test('without a click there is nothing to confirm', () => {
  assert.deepEqual(
    judgeAttempt({ clicked: false, network: { kind: 'none' }, resumeCardSeen: false }),
    { kind: 'failed', code: 'E_SELECTOR_MISSING' },
  )
})

test('network success plus a visible card is a clean submit', () => {
  assert.deepEqual(
    judgeAttempt({ clicked: true, network: { kind: 'success' }, resumeCardSeen: true }),
    { kind: 'submitted', domUnconfirmed: false },
  )
})

test('network success without the card is still a submit, flagged for later', () => {
  // The network is the authority; a missing DOM node is how a redesign announces itself.
  assert.deepEqual(
    judgeAttempt({ clicked: true, network: { kind: 'success' }, resumeCardSeen: false }),
    { kind: 'submitted', domUnconfirmed: true },
  )
})

test('DOM alone is never success', () => {
  assert.deepEqual(
    judgeAttempt({ clicked: true, network: { kind: 'none' }, resumeCardSeen: true }),
    { kind: 'uncertain', reason: 'send-unconfirmed' },
  )
})

test('no evidence at all is uncertain, not failed', () => {
  assert.deepEqual(
    judgeAttempt({ clicked: true, network: { kind: 'none' }, resumeCardSeen: false }),
    { kind: 'uncertain', reason: 'no-network-evidence' },
  )
})

test('a fatal business code fails the job and stops the run', () => {
  assert.deepEqual(
    judgeAttempt({
      clicked: true,
      network: { kind: 'fatal', code: 'E_RATE_LIMITED' },
      resumeCardSeen: false,
    }),
    { kind: 'failed', code: 'E_RATE_LIMITED', halt: 'rate-limited' },
  )
})

test('a non-fatal failure fails only the job', () => {
  assert.deepEqual(
    judgeAttempt({
      clicked: true,
      network: { kind: 'fatal', code: 'E_BODY_UNAVAILABLE' },
      resumeCardSeen: false,
    }),
    { kind: 'failed', code: 'E_BODY_UNAVAILABLE' },
  )
})

test('the halt mapping covers every run-level code', () => {
  assert.equal(haltReasonForFailure('E_CAPTCHA'), 'captcha')
  assert.equal(haltReasonForFailure('E_RATE_LIMITED'), 'rate-limited')
  assert.equal(haltReasonForFailure('E_ACCOUNT_RISK'), 'account-risk')
  assert.equal(haltReasonForFailure('E_STOKEN_EXPIRED'), 'stoken-expired')
  assert.equal(haltReasonForFailure('E_CDP_DISCONNECTED'), 'cdp-disconnected')
  assert.equal(haltReasonForFailure('E_LEDGER_WRITE'), 'ledger-write')
})

test('non-fatal and non-run-level codes have no halt reason', () => {
  assert.equal(haltReasonForFailure('E_NAV_TIMEOUT'), undefined)
  assert.equal(haltReasonForFailure('E_BODY_UNAVAILABLE'), undefined)
  assert.equal(haltReasonForFailure('E_CHROME_NOT_FOUND'), undefined)
})
