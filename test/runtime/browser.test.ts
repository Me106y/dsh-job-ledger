import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChromeDeps } from '../../src/cdp/chrome.ts'
import { resolveConfig } from '../../src/config.ts'
import { BrowserRuntime } from '../../src/runtime/browser.ts'
import type { BrowserPort } from '../../src/cdp/browser.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const CONFIG = resolveConfig({ dataDir: '/tmp/job-ledger-runtime-test', debugPort: 9444 })

/** A Chrome that only comes up after it has been launched. */
function chromeDeps(): ChromeDeps {
  let probes = 0
  return {
    probe: async () => {
      probes += 1
      return probes === 1
        ? undefined
        : { webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/browser/t', browser: 'Chrome' }
    },
    exists: () => true,
    launch: () => undefined,
    sleep: async () => undefined,
    startupTimeoutMs: 1_000,
  }
}

const PAGE = { webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/p' }

test('the first call launches a browser and connects to a page target', async () => {
  const opened: string[] = []
  const browser = new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} })
  const runtime = new BrowserRuntime(CONFIG, {
    chrome: chromeDeps(),
    pageTarget: async () => PAGE,
    openReader: async (url) => {
      opened.push(url)
      return browser
    },
  })

  const reader = await runtime.reader()

  assert.equal(reader, browser)
  assert.deepEqual(opened, [PAGE.webSocketDebuggerUrl])
  assert.equal(runtime.launched, true)
})

test('the reader is reused, so a second tool call does not relaunch Chrome', async () => {
  let opens = 0
  const browser = new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} })
  const runtime = new BrowserRuntime(CONFIG, {
    chrome: chromeDeps(),
    pageTarget: async () => PAGE,
    openReader: async () => {
      opens += 1
      return browser
    },
  })

  await runtime.reader()
  await runtime.reader()

  assert.equal(opens, 1)
})

test('two calls arriving together share one launch', async () => {
  let opens = 0
  let resolveOpen: ((reader: BrowserPort) => void) | undefined
  const runtime = new BrowserRuntime(CONFIG, {
    chrome: chromeDeps(),
    pageTarget: async () => PAGE,
    openReader: () =>
      new Promise<BrowserPort>((resolve) => {
        opens += 1
        resolveOpen = resolve
      }),
  })

  const first = runtime.reader()
  const second = runtime.reader()
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  resolveOpen?.(new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} }))

  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(opens, 1)
})

test('closing releases the reader and the next call reconnects', async () => {
  let opens = 0
  const readers: ReplayBrowser[] = []
  const runtime = new BrowserRuntime(CONFIG, {
    chrome: chromeDeps(),
    pageTarget: async () => PAGE,
    openReader: async () => {
      opens += 1
      const reader = new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} })
      readers.push(reader)
      return reader
    },
  })

  await runtime.reader()
  runtime.close()
  assert.equal(readers[0]?.closed, true)

  await runtime.reader()
  assert.equal(opens, 2)
})
