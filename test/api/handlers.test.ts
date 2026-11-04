import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../../src/api/handlers.ts'
import { SettingsStore } from '../../src/settings.ts'
import type { RouteRequest, RouteResult } from '../../src/api/handlers.ts'
import { createRunTracker } from '../../src/api/views.ts'
import type { RunStarter } from '../../src/tools/apply.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { ReaderProvider } from '../../src/runtime/browser.ts'
import type { RunRequest, RunResult } from '../../src/run/executor.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'
import { makeXlsx } from '../fixtures/xlsx.ts'
import { ReplayBrowser } from '../fixtures/transports.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

const deliver = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/deliver-list.json', import.meta.url)), 'utf8'),
) as unknown

import { writeFileSync } from 'node:fs'

const search = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cdp/search.json', import.meta.url)), 'utf8'),
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
    settings: new SettingsStore(ledger),
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
    settings: new SettingsStore(ledger),
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

test('queue/update runs one discovery pass and returns the counts with the new queue', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger, undefined, new ReplayBrowser({ search }))

  const result = await api({ method: 'POST', path: 'queue/update', body: {} })

  assert.equal(result.status, 200)
  const body = result.body as {
    source: string
    added: number
    duplicates: number
    filtered: number
    suspects: number
    queue: { rows: { jobId: string }[] }
  }
  assert.equal(body.source, 'search')
  assert.equal(body.added, 1)
  assert.equal(body.duplicates, 1)
  assert.equal(body.filtered, 1)
  assert.equal(body.suspects, 0)
  // The queue in the response already contains what the pass added.
  assert.equal(body.queue.rows.length, 1)
  assert.equal(ledger.projection.jobs.size, 2)
})

test('queue/update reports a login wall as its code instead of an empty result', async (t) => {
  const ledger = tempLedger(t)
  const browser = new ReplayBrowser({ search })
  browser.url = 'https://www.zhipin.com/web/user/?ka=header-login'
  const api = apiFor(ledger, undefined, browser)

  const result = await api({ method: 'POST', path: 'queue/update', body: {} })

  assert.equal(result.status, 401)
  assert.equal((result.body as { code: string }).code, 'E_LOGIN_REQUIRED')
})

test('queue/update is refused while a run drives the same browser', async (t) => {
  const ledger = tempLedger(t)
  const tracker = createRunTracker()
  tracker.set({ state: 'running', total: 2, done: 0 })
  const api = createApi({
    ledger,
    runner: starter(DONE).starter,
    provider: provider(new ReplayBrowser({ search })),
    tracker,
    settings: new SettingsStore(ledger),
    clock: () => NOW,
  })

  const result = await api({
    method: 'POST',
    path: 'queue/update',
    headers: { 'x-job-ledger-request': '1' },
  })

  assert.equal(result.status, 409)
  assert.equal((result.body as { code: string }).code, 'E_RUN_ACTIVE')
  // Refused before touching the ledger: the pass did not run.
  assert.equal(ledger.projection.jobs.size, 0)
})

test('queue/update is refused while a live lease says a job is being clicked', async (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_9', company: '某公司', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({
    type: 'lease/grant',
    jobId: job.id,
    owner: 'r_1',
    expiresAt: new Date(NOW + 1_000).toISOString(),
    at: AT,
  })
  const api = apiFor(ledger, undefined, new ReplayBrowser({ search }))

  const result = await api({ method: 'POST', path: 'queue/update', body: {} })

  assert.equal(result.status, 409)
  assert.equal((result.body as { code: string }).code, 'E_RUN_ACTIVE')
  assert.equal(ledger.projection.jobs.size, 1)
})

test('jobs/:id/skip records the decision and the row leaves the queue', async (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'job/decision', jobId: job.id, decision: 'new', reason: 'new', at: AT })
  const api = apiFor(ledger)
  assert.equal(((await api({ method: 'GET', path: 'queue' })).body as { rows: unknown[] }).rows.length, 1)

  const skipped = await api({ method: 'POST', path: 'jobs/j_1/skip' })

  assert.equal(skipped.status, 200)
  assert.deepEqual(skipped.body, { jobId: 'j_1', status: 'skipped' })
  assert.equal(((await api({ method: 'GET', path: 'queue' })).body as { rows: unknown[] }).rows.length, 0)
})

test('skipping an applied posting is 409, an unknown id is 400', async (t) => {
  const ledger = tempLedger(t)
  const job = makeJob({ id: 'j_2', company: '某公司', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })
  const api = apiFor(ledger)

  const applied = await api({ method: 'POST', path: 'jobs/j_2/skip' })
  assert.equal(applied.status, 409)
  assert.equal((applied.body as { code: string }).code, 'E_ALREADY_APPLIED')

  const unknown = await api({ method: 'POST', path: 'jobs/j_missing/skip' })
  assert.equal(unknown.status, 400)
  assert.equal((unknown.body as { code: string }).code, 'E_INVALID_ARGUMENT')
})

test('the tracker path is validated when saved and reported by GET tracker', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-tracker-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'tracker.xlsx')
  writeFileSync(path, makeXlsx(['公司', '岗位', 'Base地'], [['美团', '后端工程师', '上海']]))

  const bad = await api({ method: 'POST', path: 'profile', body: { trackerPath: `${dir}/nope.xlsx` } })
  assert.equal(bad.status, 400)
  assert.equal((bad.body as { code: string }).code, 'E_TRACKER_PATH')

  const saved = await api({ method: 'POST', path: 'profile', body: { trackerPath: path } })
  assert.equal(saved.status, 200)
  const settings = saved.body as { tracker: { path: string; format: string } }
  assert.equal(settings.tracker.format, 'xlsx')

  const view = await api({ method: 'GET', path: 'tracker' })
  assert.equal(view.status, 200)
  assert.deepEqual((view.body as { headers: string[] }).headers, ['公司', '岗位', 'Base地'])
})

test('tracker/sync imports history and writes the ledger application into the sheet', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-tracker-sync-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'tracker.xlsx')
  writeFileSync(path, makeXlsx(['公司', '岗位', 'Base地', '投递日期', '状态'], [['快手', 'AI 全栈', '北京', '9.20', '简历挂']]))
  await api({ method: 'POST', path: 'profile', body: { trackerPath: path } })

  const job = makeJob({ id: 'j_1', company: '美团', title: '后端工程师', city: '上海' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })

  const result = await api({ method: 'POST', path: 'tracker/sync' })

  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { revision: ledger.projection.revision, imported: 1, matched: 0, written: 1 })
})

test('tracker/sync without a configured sheet is a coded 400', async (t) => {
  const ledger = tempLedger(t)
  const api = apiFor(ledger)

  const result = await api({ method: 'POST', path: 'tracker/sync' })

  assert.equal(result.status, 400)
  assert.equal((result.body as { code: string }).code, 'E_TRACKER_PATH')
})
