import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API_PREFIX, createApi } from '../../src/api/handlers.ts'
import { mountApi } from '../../src/api/mount.ts'
import { createRunTracker } from '../../src/api/views.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import type { RunResult } from '../../src/run/executor.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const DONE: RunResult = {
  runId: 'r_1',
  outcome: 'done',
  summary: { submitted: 0, uncertain: 0, failed: 0, skipped: 0 },
}

/** @param t test context @returns a running server, its base URL, and a cleanup */
async function serveApi(t: { after(fn: () => void): void }): Promise<{ base: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-http-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())

  const provider: ReaderProvider = { reader: async () => new ReplayBrowser({ baseinfo: {}, expect: {}, status: {} }) }
  const api = createApi({
    ledger,
    runner: { run: async () => DONE },
    provider,
    tracker: createRunTracker(),
    clock: () => NOW,
  })

  // Mount exactly as the plugin does, then let a real node:http server dispatch to that route.
  const routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>()
  mountApi(
    {
      register(route) {
        routes.set(route.path, route.handler as (req: unknown, res: unknown) => void | Promise<void>)
        return () => undefined
      },
    },
    api,
  )
  const handler = routes.get(API_PREFIX.replace(/\/$/, ''))
  assert.ok(handler !== undefined)

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith(API_PREFIX) !== true || handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    // `fetch` keeps connections alive; without this the server waits them out and the test hangs.
    server.closeAllConnections()
    server.close()
  })
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${String(port)}${API_PREFIX}` }
}

const HEADERS = { 'x-job-ledger-request': '1' }

test('the mounted route answers JSON over real HTTP', async (t) => {
  const { base } = await serveApi(t)

  const response = await fetch(`${base}overview`, { headers: HEADERS })
  const body = (await response.json()) as { today: { quota: number } }

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(body.today.quota, 30)
})

test('the CSRF header is enforced over HTTP too', async (t) => {
  const { base } = await serveApi(t)

  const response = await fetch(`${base}queue`)

  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as { code: string }).code, 'E_INVALID_ARGUMENT')
})

test('a POST body survives the HTTP round trip', async (t) => {
  const { base } = await serveApi(t)

  const response = await fetch(`${base}run/start`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  })
  const body = (await response.json()) as { state: string }

  assert.equal(response.status, 200)
  assert.equal(body.state, 'done')
})

test('an unknown path under the prefix is a 404 with a code', async (t) => {
  const { base } = await serveApi(t)

  const response = await fetch(`${base}nope`, { headers: HEADERS })

  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as { code: string }).code, 'E_INVALID_ARGUMENT')
})
