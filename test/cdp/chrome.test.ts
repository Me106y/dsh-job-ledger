import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginError } from '../../src/shared/errors.ts'
import {
  chromeCandidates,
  ensureChrome,
  launchArgs,
  probeDebugPort,
} from '../../src/cdp/chrome.ts'
import type { DebugTarget } from '../../src/cdp/chrome.ts'

const OPTIONS = { debugPort: 9333, profileDir: '/tmp/job-ledger-profile' }

test('the launch line pins the port and the dedicated profile', () => {
  const args = launchArgs(OPTIONS)
  assert.ok(args.includes('--remote-debugging-port=9333'))
  assert.ok(args.includes('--user-data-dir=/tmp/job-ledger-profile'))
  // Chrome 111+ rejects the handshake without this when a client sends an Origin header.
  assert.ok(args.includes('--remote-allow-origins=*'))
})

test('candidate paths exist for every supported platform', () => {
  assert.ok(chromeCandidates('darwin').some((path) => path.includes('Google Chrome')))
  assert.ok(chromeCandidates('linux').includes('/usr/bin/google-chrome'))
  assert.ok(chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }).length > 0)
})

test('a browser already listening is reused rather than replaced', async () => {
  let launched = false
  const handle = await ensureChrome(OPTIONS, {
    probe: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/x', browser: 'Chrome/120' }),
    launch: () => {
      launched = true
    },
  })

  assert.equal(launched, false)
  assert.equal(handle.launched, false)
  assert.equal(handle.webSocketUrl, 'ws://127.0.0.1:9333/devtools/browser/x')
})

test('no browser and no binary is E_CHROME_NOT_FOUND', async () => {
  await assert.rejects(
    ensureChrome(OPTIONS, {
      probe: async () => undefined,
      exists: () => false,
      platform: 'linux',
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_CHROME_NOT_FOUND')
      return true
    },
  )
})

test('a launch that never opens the port is E_CHROME_NOT_STARTED', async () => {
  await assert.rejects(
    ensureChrome(OPTIONS, {
      probe: async () => undefined,
      exists: () => true,
      launch: () => undefined,
      sleep: async () => undefined,
      startupTimeoutMs: 30,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_CHROME_NOT_STARTED')
      return true
    },
  )
})

test('a launch that comes up is reported as launched', async () => {
  let probes = 0
  const target: DebugTarget = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/y',
    browser: 'Chrome/120',
  }
  const handle = await ensureChrome(OPTIONS, {
    probe: async () => {
      probes += 1
      return probes > 1 ? target : undefined
    },
    exists: () => true,
    launch: () => undefined,
    sleep: async () => undefined,
    startupTimeoutMs: 1_000,
  })

  assert.equal(handle.launched, true)
  assert.equal(handle.webSocketUrl, target.webSocketDebuggerUrl)
})

test('probing a closed port returns undefined instead of throwing', async () => {
  // Port 1 is not listening; the point is that a dead port is not an exception.
  assert.equal(await probeDebugPort(1), undefined)
})
