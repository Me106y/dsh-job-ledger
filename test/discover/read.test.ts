import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PluginError } from '../../src/shared/errors.ts'
import { BOSS_URLS } from '../../src/cdp/boss.ts'
import { discoveryUrl, readJobList } from '../../src/discover/read.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const search = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/search.json', import.meta.url)), 'utf8'),
) as unknown

test('search builds a query URL from the first configured role', () => {
  const url = discoveryUrl('search', ['后端工程师'])
  assert.ok(url.startsWith(BOSS_URLS.search))
  assert.match(url, /query=%E5%90%8E%E7%AB%AF%E5%B7%A5%E7%A8%8B%E5%B8%88/)
})

test('search without a role falls back to the page default', () => {
  assert.equal(discoveryUrl('search', []), BOSS_URLS.search)
})

test('recommend uses the page as-is', () => {
  assert.equal(discoveryUrl('recommend', ['后端工程师']), BOSS_URLS.search)
})

test('a search read returns parsed jobs', async () => {
  const browser = new ReplayBrowser({ search })

  const result = await readJobList(browser, 'search', ['后端工程师'])

  assert.equal(result.source, 'search')
  assert.equal(result.jobs.length, 3)
  assert.equal(result.invalid, 1)
  assert.match(browser.navigated ?? '', /query=/)
})

test('a recommend read captures the recommendation endpoint', async () => {
  const browser = new ReplayBrowser({ recommend: search })

  const result = await readJobList(browser, 'recommend')

  assert.equal(result.source, 'recommend')
  assert.equal(result.jobs.length, 3)
  assert.equal(browser.navigated, BOSS_URLS.search)
})

test('the login wall stops discovery before it waits for a list', async () => {
  const browser = new ReplayBrowser({ search })
  browser.url = 'https://www.zhipin.com/web/user/?ka=header-login'

  await assert.rejects(readJobList(browser, 'search', ['后端工程师']), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_LOGIN_REQUIRED')
    return true
  })
})

test('a rate-limited list surfaces as E_RATE_LIMITED', async () => {
  const browser = new ReplayBrowser({ search: { code: 9 } })

  await assert.rejects(readJobList(browser, 'search', ['后端工程师']), (error: unknown) => {
    assert.ok(error instanceof PluginError)
    assert.equal(error.code, 'E_RATE_LIMITED')
    return true
  })
})
