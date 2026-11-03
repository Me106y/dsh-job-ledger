import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../../src/api/handlers.ts'
import type { ApiHandlers } from '../../src/api/handlers.ts'
import { MAX_BODY_BYTES, handleHttp, mountApi, routeRequestFrom } from '../../src/api/mount.ts'
import { createRunTracker } from '../../src/api/views.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import type { RunResult } from '../../src/run/executor.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

const DONE: RunResult = {
  runId: 'r_1',
  outcome: 'done',
  summary: { submitted: 0, uncertain: 0, failed: 0, skipped: 0 },
}

/** @param t test context @returns an api wired to a temp ledger */
function apiFor(t: { after(fn: () => void): void }): ApiHandlers {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-mount-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  const provider: ReaderProvider = { reader: async () => new ReplayBrowser({ deliver }) }
  return createApi({
    ledger,
    runner: { run: async () => DONE },
    provider,
    tracker: createRunTracker(),
    clock: () => NOW,
  })
}

/** @param parts request description @returns a fake IncomingMessage */
function request(parts: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const stream = Readable.from(parts.body === undefined ? [] : [Buffer.from(parts.body)])
  return Object.assign(stream, {
    method: parts.method,
    url: parts.url,
    headers: parts.headers ?? {},
  }) as unknown as IncomingMessage
}

/** @returns a fake response plus the fields a test inspects */
function response(): {
  res: ServerResponse
  captured: { status: number; headers: Record<string, string>; body: string }
} {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    get statusCode(): number {
      return captured.status
    },
    set statusCode(value: number) {
      captured.status = value
    },
    setHeader(name: string, value: string): void {
      captured.headers[name] = value
    },
    end(body: string): void {
      captured.body = body
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

const HEADERS = { 'x-job-ledger-request': '1' }

test('the api is mounted as one prefix route under /job-ledger/api', () => {
  let registered: { kind: string; path: string } | undefined
  const dispose = mountApi(
    {
      register(route) {
        registered = route
        return () => undefined
      },
    },
    apiFor({ after: () => undefined }),
  )

  assert.equal(registered?.kind, 'prefix')
  assert.equal(registered?.path, '/job-ledger/api')
  dispose()
})

test('a GET request reaches the handler and answers JSON', async (t) => {
  const api = apiFor(t)
  const { res, captured } = response()

  await handleHttp(request({ method: 'GET', url: '/job-ledger/api/overview', headers: HEADERS }), res, api)

  assert.equal(captured.status, 200)
  assert.match(captured.headers['content-type'] ?? '', /application\/json/)
  const body = JSON.parse(captured.body) as { today: { quota: number } }
  assert.equal(body.today.quota, 30)
})

test('the prefix is stripped and the query string is parsed', () => {
  const req = request({ method: 'GET', url: '/job-ledger/api/queue?filter=suspect&limit=5' })
  const parsed = routeRequestFrom(req, undefined)

  assert.equal(parsed.path, 'queue')
  assert.equal(parsed.query?.['filter'], 'suspect')
  assert.equal(parsed.query?.['limit'], '5')
})

test('a POST body is parsed as JSON', async (t) => {
  const api = apiFor(t)
  const { res, captured } = response()

  await handleHttp(
    request({
      method: 'POST',
      url: '/job-ledger/api/run/start',
      headers: HEADERS,
      body: JSON.stringify({ ids: ['j_1'] }),
    }),
    res,
    api,
  )

  assert.equal(captured.status, 200)
  assert.equal((JSON.parse(captured.body) as { state: string }).state, 'done')
})

test('the CSRF header is enforced at the handler, not the mount', async (t) => {
  const api = apiFor(t)
  const { res, captured } = response()

  await handleHttp(request({ method: 'GET', url: '/job-ledger/api/queue' }), res, api)

  assert.equal(captured.status, 403)
})

test('a body that is not JSON is a 400, not a crash', async (t) => {
  const api = apiFor(t)
  const { res, captured } = response()

  await handleHttp(
    request({ method: 'POST', url: '/job-ledger/api/run/start', headers: HEADERS, body: '{nope' }),
    res,
    api,
  )

  assert.equal(captured.status, 400)
  assert.equal((JSON.parse(captured.body) as { code: string }).code, 'E_INVALID_ARGUMENT')
})

test('an oversized body is refused before it is parsed', async (t) => {
  const api = apiFor(t)
  const { res, captured } = response()

  await handleHttp(
    request({
      method: 'POST',
      url: '/job-ledger/api/run/start',
      headers: HEADERS,
      body: 'x'.repeat(MAX_BODY_BYTES + 10),
    }),
    res,
    api,
  )

  assert.equal(captured.status, 400)
})
