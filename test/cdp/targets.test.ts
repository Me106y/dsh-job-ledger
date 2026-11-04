import assert from 'node:assert/strict'
import test from 'node:test'

import { findPageTarget } from '../../src/cdp/chrome.ts'

/** @param url page url @returns a page target as Chrome lists it */
function page(url: string): Record<string, unknown> {
  return { type: 'page', url, webSocketDebuggerUrl: `ws://${url}` }
}

/** @param pages what /json/list returns @param created what /json/new returns @returns a fetch stub and its calls */
function fakeFetch(
  pages: readonly unknown[],
  created: unknown = page('about:blank'),
): { fetch: typeof fetch; calls: { url: string; method: string | undefined }[] } {
  const calls: { url: string; method: string | undefined }[] = []
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, method: init?.method })
    if (url.includes('/json/list')) return new Response(JSON.stringify(pages), { status: 200 })
    if (url.includes('/json/new')) return new Response(JSON.stringify(created), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  return { fetch: impl as typeof fetch, calls }
}

test('a BOSS tab is chosen over the page the user is on, such as the DSH panel', async () => {
  const { fetch } = fakeFetch([
    page('http://127.0.0.1:3080/'),
    page('https://www.zhipin.com/web/geek/jobs?query=AI'),
  ])

  const target = await findPageTarget(9222, fetch)

  assert.equal(target?.browser, 'https://www.zhipin.com/web/geek/jobs?query=AI')
})

test('with only foreign tabs, a new tab is opened instead of taking one over', async () => {
  const { fetch, calls } = fakeFetch([page('http://127.0.0.1:3080/')], page('about:blank'))

  const target = await findPageTarget(9222, fetch)

  assert.equal(target?.browser, 'about:blank')
  // The DSH page was never returned as a target; Chrome was asked for a fresh tab.
  assert.ok(calls.some((call) => call.url.includes('/json/new') && call.method === 'PUT'))
})

test('a blank tab of our own is reused before opening another one', async () => {
  const { fetch, calls } = fakeFetch([page('http://127.0.0.1:3080/'), page('about:blank')], page('about:blank'))

  const target = await findPageTarget(9222, fetch)

  assert.equal(target?.browser, 'about:blank')
  assert.ok(!calls.some((call) => call.url.includes('/json/new')))
})

test('no page at all and no new tab means no target', async () => {
  const impl = (async (input: string | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/json/list')) return new Response('[]', { status: 200 })
    return new Response('{}', { status: 500 })
  }) as typeof fetch

  assert.equal(await findPageTarget(9222, impl), undefined)
})
