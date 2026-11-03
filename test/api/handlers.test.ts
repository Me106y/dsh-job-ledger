import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../../src/api/handlers.ts'
import type { RouteRequest, RouteResult } from '../../src/api/handlers.ts'
import { createRunTracker } from '../../src/api/views.ts'
import type { RunStarter } from '../../src/tools/apply.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import type { RunRequest, RunResult } from '../../src/run/executor.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

/** @param t test context @returns an open ledger in a temp directory */
function tempLedger(t: { after(fn: () => void): void }): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return ledger
}

const DONE: RunResult = {
  runId: 'r_1',
  outcome: 'done',
  summary: { submitted: 1, uncertain: 0, failed: 0, skipped: 0 },
}

/** @param result what the run returns @returns a starter plus the requests it saw */
function starter(result: RunResult): { starter: RunStarter; seen: RunRequest[] } {
  const seen: RunRequest[] = []
  return {
    seen,
    starter: {
      async run(request: RunRequest): Promise<RunResult> {
        seen.push(request)
        return result
      },
    },
  }
}

/** @param browser fake page @returns a provider */
function provider(browser: ReplayBrowser): ReaderProvider {
  return { reader: async () => browser }
}

/** @param ledger ledger @param run starter @returns a request function with the CSRF header */
function apiFor(
  ledger: Ledger,
  run: RunStarter = starter(DONE).starter,
  browser = new ReplayBrowser({ deliver }),
) {
  const api = createApi({
    ledger,
    runner: run,
    provider: provider(browser),
    tracker: createRunTracker(),
    clock: () => NOW,
  })
  return (request: RouteRequest): Promise<RouteResult> =>
    api({ headers: { 'x-job-ledger-request': '1' }, ...request })
}

test('a request without the panel header is refused', async (t) => {
  const ledger = tempLedger(t)
  const api = createApi({
    ledger,
    runner: starter(DONE).starter,
    provider: provider(new ReplayBrowser({ deliver })),
    tracker: createRunTracker(),
    clock: () => NOW,
  })

  const result = await api({ method: 'GET', path: 'queue' })

  assert.equal(result.status, 403)
  assert.equal((result.body as { code: string }).code, 'E_INVALID_ARGUMENT')
})

test('the queue route returns the view and honours the filter', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const result = await api({ method: 'GET', path: 'queue', query: { filter: 'filtered' } })

  assert.equal(result.status, 200)
  assert.equal((result.body as { filtered: number }).filtered, 0)
})

test('run/start records the panel as the authorizer and reports the outcome', async (t) => {
  const ledger = tempLedger(t)
  const { starter: runStarter, seen } = starter(DONE)
  const api = apiFor(ledger, runStarter)

  const result = await api({ method: 'POST', path: 'run/start', body: { ids: ['j_1'] } })

  assert.equal(result.status, 200)
  assert.deepEqual(seen[0]?.grantedBy, { kind: 'panel', at: AT })
  const body = result.body as { state: string; done: number; runId: string }
  assert.equal(body.state, 'done')
  assert.equal(body.done, 1)
  assert.equal(body.runId, 'r_1')
})

test('a refused run maps to 409 with its code', async (t) => {
  const ledger = tempLedger(t)
  const refusing: RunStarter = {
    async run() {
      throw Object.assign(new Error('busy'), { name: 'PluginError' })
    },
  }
  void refusing
  const api = apiFor(ledger, {
    async run() {
      const { PluginError } = await import('../../src/shared/errors.ts')
      throw new PluginError('E_RUN_ACTIVE')
    },
  })

  const result = await api({ method: 'POST', path: 'run/start', body: { ids: ['j_1'] } })

  assert.equal(result.status, 409)
  assert.equal((result.body as { code: string }).code, 'E_RUN_ACTIVE')
})

test('run/start without ids is a 400, not a crash', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const result = await api({ method: 'POST', path: 'run/start', body: {} })

  assert.equal(result.status, 400)
  assert.equal((result.body as { code: string }).code, 'E_INVALID_ARGUMENT')
})

test('a panel state change goes through the ledger and an illegal one is 409', async (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })
  const api = apiFor(ledger)

  const ok = await api({
    method: 'POST',
    path: 'apps/a_1/state',
    body: { state: 'replied', note: 'HR 回复了' },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { appId: 'a_1', state: 'replied' })

  const bad = await api({ method: 'POST', path: 'apps/a_1/state', body: { state: 'queued' } })
  assert.equal(bad.status, 409)
  assert.equal((bad.body as { code: string }).code, 'E_ILLEGAL_TRANSITION')
})

test('reconcile/run returns both sides of the comparison', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const result = await api({ method: 'POST', path: 'reconcile/run' })

  assert.equal(result.status, 200)
  const body = result.body as { platformOnly: unknown[]; ledgerOnly: unknown[]; partial: boolean }
  assert.equal(body.platformOnly.length, 3)
  assert.equal(body.ledgerOnly.length, 0)
  assert.equal(body.partial, true)
})

test('the last reconcile result is what GET reconcile shows', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const before = await api({ method: 'GET', path: 'reconcile' })
  assert.deepEqual((before.body as { platformOnly: unknown[] }).platformOnly, [])

  await api({ method: 'POST', path: 'reconcile/run' })
  const after = await api({ method: 'GET', path: 'reconcile' })
  assert.equal((after.body as { platformOnly: unknown[] }).platformOnly.length, 3)
})

test('an unknown route is a 404 with a code', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const result = await api({ method: 'GET', path: 'nothing/here' })

  assert.equal(result.status, 404)
  assert.equal((result.body as { code: string }).code, 'E_INVALID_ARGUMENT')
})
