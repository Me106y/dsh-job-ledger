import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ERROR_MESSAGES,
  failure,
  fillTemplate,
  isErrorCode,
  isFatal,
  isRetryable,
  userMessage,
} from '../src/shared/errors.ts'

test('every code has a non-empty user message', () => {
  for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
    assert.equal(typeof message, 'string', `${code} message must be a string`)
    assert.ok(message.length > 0, `${code} message must not be empty`)
  }
})

test('codes are unique by construction and all start with E_', () => {
  const codes = Object.keys(ERROR_MESSAGES)
  assert.equal(new Set(codes).size, codes.length)
  for (const code of codes) assert.match(code, /^E_[A-Z0-9_]+$/)
})

test('isErrorCode rejects unknown values', () => {
  assert.equal(isErrorCode('E_LOGIN_REQUIRED'), true)
  assert.equal(isErrorCode('E_NOT_A_REAL_CODE'), false)
  assert.equal(isErrorCode(undefined), false)
  assert.equal(isErrorCode(42), false)
})

test('fatal and retryable sets only contain known codes', () => {
  for (const code of Object.keys(ERROR_MESSAGES)) {
    if (isErrorCode(code)) {
      // Both helpers must be total functions over the code space.
      assert.equal(typeof isFatal(code), 'boolean')
      assert.equal(typeof isRetryable(code), 'boolean')
    }
  }
})

test('a fatal failure is never reported as retryable', () => {
  for (const code of Object.keys(ERROR_MESSAGES)) {
    if (!isErrorCode(code)) continue
    assert.ok(!(isFatal(code) && isRetryable(code)), `${code} cannot be both fatal and retryable`)
  }
})

test('fillTemplate substitutes values and leaves unknown placeholders visible', () => {
  assert.equal(fillTemplate('已投 {n} 个', { n: '3' }), '已投 3 个')
  assert.equal(fillTemplate('已投 {n} 个 / {missing}', { n: '3' }), '已投 3 个 / {missing}')
  assert.equal(fillTemplate('无占位符'), '无占位符')
})

test('userMessage renders the table entry', () => {
  assert.equal(userMessage('E_DAILY_QUOTA'), ERROR_MESSAGES.E_DAILY_QUOTA)
})

test('failure omits values when none are given', () => {
  assert.deepEqual(failure('E_CAPTCHA'), { code: 'E_CAPTCHA' })
  assert.deepEqual(failure('E_ILLEGAL_TRANSITION', { allowed: 'queued' }), {
    code: 'E_ILLEGAL_TRANSITION',
    values: { allowed: 'queued' },
  })
})
