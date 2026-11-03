import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { BOSS_URLS } from '../../src/cdp/boss.ts'
import { readResume } from '../../src/resume/read.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/resume.json', import.meta.url)), 'utf8'),
) as { baseinfo: unknown; expect: unknown; status: unknown }

test('reading the resume navigates to the resume page and parses the result', async () => {
  const browser = new ReplayBrowser(fixture)
  const resume = await readResume(browser)

  assert.equal(browser.navigated, BOSS_URLS.resume)
  assert.equal(resume.expectedRoles[0], '后端工程师')
  assert.equal(resume.skills.length, 3)
})

test('all three captures are armed before navigation', async () => {
  // Arming after navigate would wait forever for responses that already went by.
  const browser = new ReplayBrowser(fixture)
  await readResume(browser)

  assert.equal(browser.patterns.length, 3)
  assert.equal(browser.capturesAtNavigate, 3)
})

test('a rejected login surfaces as E_STOKEN_EXPIRED, not an empty resume', async () => {
  const browser = new ReplayBrowser({
    baseinfo: { code: 37, message: 'stoken expired' },
    expect: { code: 37 },
    status: { code: 37 },
  })

  await assert.rejects(readResume(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_STOKEN_EXPIRED')
    return true
  })
})

test('rate limiting surfaces as E_RATE_LIMITED', async () => {
  const browser = new ReplayBrowser({
    baseinfo: { code: 9 },
    expect: { code: 9 },
    status: { code: 9 },
  })

  await assert.rejects(readResume(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_RATE_LIMITED')
    return true
  })
})

test('an unknown business code is a body failure, not a silent success', async () => {
  const browser = new ReplayBrowser({
    baseinfo: { code: 99 },
    expect: { code: 0 },
    status: { code: 0 },
  })

  await assert.rejects(readResume(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_BODY_UNAVAILABLE')
    return true
  })
})

test('a redirect to the login wall fails fast instead of waiting for captures', async () => {
  const browser = new ReplayBrowser(fixture)
  browser.url = 'https://www.zhipin.com/web/user/?ka=header-login'

  await assert.rejects(readResume(browser), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_LOGIN_REQUIRED')
    return true
  })
})
