import assert from 'node:assert/strict'
import test from 'node:test'

import { BOSS_SELECTORS, BOSS_URLS } from '../../src/cdp/boss.ts'
import { LOGIN_TOOL_NAME, loginForModel, renderLoginResult } from '../../src/tools/login.ts'
import type { LoginToolOptions } from '../../src/tools/login.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import { PluginError } from '../../src/shared/errors.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const LOGIN = 'https://www.zhipin.com/web/user/'
const JOB = 'https://www.zhipin.com/web/geek/job'

/** @param urls the sequence the fake page reports @returns a reader plus the provider */
function providerWith(urls: readonly string[]): { provider: ReaderProvider; browser: ReplayBrowser } {
  const browser = new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} })
  let index = 0
  browser.currentUrl = async () => {
    const url = urls[Math.min(index, urls.length - 1)] ?? 'about:blank'
    index += 1
    return url
  }
  return { provider: { reader: async () => browser }, browser }
}

const FAST: LoginToolOptions = { timeoutMs: 5_000, pollMs: 0, sleep: async () => undefined }

test('a valid session is reported without opening the login page', async () => {
  const { provider, browser } = providerWith([JOB])

  const result = await loginForModel(provider, FAST)

  assert.deepEqual(result, { ok: true, alreadyLoggedIn: true, url: JOB })
  assert.equal(browser.navigated, undefined)
})

test('a login wall puts the QR page in front and waits for the redirect away', async () => {
  const { provider, browser } = providerWith([LOGIN, LOGIN, LOGIN, JOB])

  const result = await loginForModel(provider, FAST)

  assert.deepEqual(result, { ok: true, alreadyLoggedIn: false, url: JOB })
  assert.equal(browser.navigated, BOSS_URLS.login)
})

test('the QR tab is opened, because the page defaults to SMS', async () => {
  const { provider, browser } = providerWith([LOGIN, JOB])

  await loginForModel(provider, FAST)

  assert.deepEqual(browser.clicked, [BOSS_SELECTORS.loginQrSwitch])
})

test('a page without the QR tab still lets the person log in', async () => {
  const { provider, browser } = providerWith([LOGIN, JOB])
  browser.clickError = new PluginError('E_SELECTOR_MISSING', { what: BOSS_SELECTORS.loginQrSwitch })

  const result = await loginForModel(provider, FAST)

  assert.equal(result.ok, true)
})

test('a person who never scans gets a coded timeout, not a fake success', async () => {
  const { provider } = providerWith([LOGIN])

  const result = await loginForModel(provider, { ...FAST, timeoutMs: 0 })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_LOGIN_REQUIRED')
  assert.match(result.message, /超时/)
})

test('a browser failure is reported with its code', async () => {
  const provider: ReaderProvider = {
    async reader() {
      throw new PluginError('E_CDP_DISCONNECTED')
    },
  }

  const result = await loginForModel(provider, FAST)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_CDP_DISCONNECTED')
})

test('rendering distinguishes "already in" from "just logged in"', () => {
  assert.equal(renderLoginResult({ ok: true, alreadyLoggedIn: true, url: JOB }), `已登录：${JOB}`)
  assert.match(
    renderLoginResult({ ok: true, alreadyLoggedIn: false, url: JOB }),
    /登录成功.*登录态已保存/,
  )
  assert.match(
    renderLoginResult({ ok: false, code: 'E_LOGIN_REQUIRED', message: '超时' }),
    /^\[E_LOGIN_REQUIRED\]/,
  )
  assert.equal(LOGIN_TOOL_NAME, 'job_ledger_login')
})
