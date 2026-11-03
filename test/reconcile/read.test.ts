import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { BOSS_URLS } from '../../src/cdp/boss.ts'
import { readDelivered } from '../../src/reconcile/read.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

test('reading the delivered list happens on the chat page', async () => {
  const browser = new ReplayBrowser({ deliver })

  const result = await readDelivered(browser)

  assert.equal(browser.navigated, BOSS_URLS.chat)
  assert.equal(result.rows.length, 3)
  assert.equal(result.invalid, 1)
  // Only page one is read, and the caller is told so.
  assert.equal(result.partial, true)
})

test('the capture is armed before navigation', async () => {
  const browser = new ReplayBrowser({ deliver })
  await readDelivered(browser)

  assert.equal(browser.capturesAtNavigate, 1)
})

test('a login wall stops reconciliation early', async () => {
  const browser = new ReplayBrowser({ deliver })
  browser.url = 'https://www.zhipin.com/web/user/?login'

  await assert.rejects(readDelivered(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_LOGIN_REQUIRED')
    return true
  })
})

test('a rate-limited list surfaces as E_RATE_LIMITED', async () => {
  const browser = new ReplayBrowser({ deliver: { code: 9 } })

  await assert.rejects(readDelivered(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_RATE_LIMITED')
    return true
  })
})
