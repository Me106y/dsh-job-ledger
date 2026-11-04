import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApi } from '../../src/api/handlers.ts'
import type { RouteRequest, RouteResult } from '../../src/api/handlers.ts'
import { createRunTracker } from '../../src/api/views.ts'
import { Ledger } from '../../src/ledger/store.ts'
import type { RunRequest, RunResult } from '../../src/run/executor.ts'
import { DEFAULT_PROFILE } from '../../src/shared/profile.ts'
import { SettingsStore } from '../../src/settings.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

const DONE: RunResult = {
  runId: 'r_1',
  outcome: 'done',
  summary: { submitted: 0, uncertain: 0, failed: 0, skipped: 0 },
}

/** @param t test context @returns a ledger and a settings store in the same temp directory */
function fixture(t: { after(fn: () => void): void }): {
  ledger: Ledger
  settings: SettingsStore
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-profile-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => {
    ledger.close()
  })
  const settings = new SettingsStore(ledger)
  return { ledger, settings, dir }
}

/** @param fixture ledger + settings @returns an API caller with the panel header */
function apiFor(fixture: { ledger: Ledger; settings: SettingsStore }) {
  const api = createApi({
    ledger: fixture.ledger,
    runner: {
      async run(_request: RunRequest): Promise<RunResult> {
        return DONE
      },
    },
    provider: {
      async reader() {
        throw new Error('the profile route must not touch the browser')
      },
    },
    tracker: createRunTracker(),
    settings: fixture.settings,
    clock: () => NOW,
  })
  return (request: RouteRequest): Promise<RouteResult> =>
    api({ headers: { 'x-job-ledger-request': '1' }, ...request })
}

test('GET profile reports the effective target and the hard limits', async (t) => {
  const call = apiFor(fixture(t))

  const result = await call({ method: 'GET', path: 'profile' })

  assert.equal(result.status, 200)
  const body = result.body as {
    target: { roles: string[]; cities: string[]; salaryMin: number }
    limits: { runSize: number; daily: number }
  }
  assert.deepEqual(body.target, { roles: [], cities: [], salaryMin: 0 })
  assert.deepEqual(body.limits, { runSize: 10, daily: 30 })
})

test('POST profile saves the target and the next GET sees it', async (t) => {
  const fixtureValue = fixture(t)
  const call = apiFor(fixtureValue)

  const saved = await call({
    method: 'POST',
    path: 'profile',
    body: { roles: ['后端开发'], cities: ['上海', '杭州'], salaryMin: 20 },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual((saved.body as { target: { roles: string[] } }).target.roles, ['后端开发'])

  const read = await call({ method: 'GET', path: 'profile' })
  assert.deepEqual((read.body as { target: { cities: string[] } }).target.cities, ['上海', '杭州'])
})

test('POST profile appends one profile/set event the next boot replays', async (t) => {
  const value = fixture(t)
  const call = apiFor(value)

  await call({ method: 'POST', path: 'profile', body: { salaryMin: 18 } })

  const lines = readFileSync(join(value.dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; profile?: { target?: { salaryMin?: number } } })
  const saved = lines.filter((line) => line.type === 'profile/set')
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.profile?.target?.salaryMin, 18)
})

test('an invalid target is a 400, not a partial save', async (t) => {
  const fixtureValue = fixture(t)
  const call = apiFor(fixtureValue)

  const result = await call({ method: 'POST', path: 'profile', body: { salaryMin: -5 } })

  assert.equal(result.status, 400)
  assert.equal((result.body as { code: string }).code, 'E_INVALID_ARGUMENT')
  assert.deepEqual(fixtureValue.settings.target, { roles: [], cities: [], salaryMin: 0 })
})

test('the profile route still requires the panel header', async (t) => {
  const fixtureValue = fixture(t)
  const api = createApi({
    ledger: fixtureValue.ledger,
    runner: { async run(): Promise<RunResult> { return DONE } },
    provider: { async reader() { throw new Error('not used') } },
    tracker: createRunTracker(),
    settings: fixtureValue.settings,
    clock: () => NOW,
  })

  const result = await api({ method: 'GET', path: 'profile' })
  assert.equal(result.status, 403)
})
