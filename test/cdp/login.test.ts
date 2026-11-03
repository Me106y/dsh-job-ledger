import assert from 'node:assert/strict'
import test from 'node:test'

import { assertLoggedIn, waitForLogin } from '../../src/cdp/login.ts'
import { isLoginUrl } from '../../src/cdp/boss.ts'
import { PluginError } from '../../src/shared/errors.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

/** @param urls sequence of URLs the fake page reports @returns a reader that walks them */
function readerAt(urls: readonly string[]): ReplayBrowser {
  const browser = new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} })
  let index = 0
  Object.defineProperty(browser, 'url', {
    get() {
      const url = urls[Math.min(index, urls.length - 1)] ?? 'about:blank'
      index += 1
      return url
    },
  })
  return browser
}

test('a redirect that lands after navigation is still caught', async () => {
  // Observed on a real logged-out session: the search URL answers, then redirects to /web/user/.
  const browser = readerAt([
    'https://www.zhipin.com/web/geek/job',
    'https://www.zhipin.com/web/geek/job',
    'https://www.zhipin.com/web/user/',
  ])

  await assert.rejects(
    assertLoggedIn(browser, [], { intervalMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LOGIN_REQUIRED')
      return true
    },
  )
})

test('a logged-in session resolves after the grace period without throwing', async () => {
  const browser = readerAt(['https://www.zhipin.com/web/geek/job'])
  await assert.doesNotReject(assertLoggedIn(browser, [], { intervalMs: 0 }))
})

test('waiting for a login needs to have seen the login page first', async () => {
  // Right after a navigation the browser can still report the previous URL; that is not a login.
  const stale = readerAt(['https://www.zhipin.com/web/geek/job'])
  assert.equal(await waitForLogin(stale, { timeoutMs: 0 }), false)
})

test('waiting for a login succeeds once the page leaves the login URL', async () => {
  const browser = readerAt([
    'https://www.zhipin.com/web/user/',
    'https://www.zhipin.com/web/user/',
    'https://www.zhipin.com/web/geek/job',
  ])
  assert.equal(
    await waitForLogin(browser, { timeoutMs: 5_000, pollMs: 0, sleep: async () => undefined }),
    true,
  )
})

test('the real logout redirect is recognised as a login URL', () => {
  assert.equal(isLoginUrl('https://www.zhipin.com/web/user/'), true)
  assert.equal(isLoginUrl('https://www.zhipin.com/web/geek/job'), false)
})

test('pending captures are swallowed when the wall is hit', async () => {
  const browser = readerAt(['https://www.zhipin.com/web/user/'])
  let swallowed = false
  const pending = [
    new Promise(() => undefined),
    Promise.reject(new Error('never resolved')).catch(() => {
      swallowed = true
    }),
  ]

  await assert.rejects(assertLoggedIn(browser, pending, { intervalMs: 0 }), /登录/)
  assert.equal(swallowed, true)
})
