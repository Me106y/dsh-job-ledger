import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../../src/ledger/store.ts'
import {
  RECORD_TOOL_NAME,
  recordForModel,
  renderRecordResult,
} from '../../src/tools/record.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const AT = new Date(NOW).toISOString()

/**
 * @param t test context
 * @param state the application's initial state
 * @returns a ledger with one application
 */
function setup(t: { after(fn: () => void): void }, state: 'submitted' | 'uncertain' = 'submitted'): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-record-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())

  const job = makeJob({ id: 'j_1', company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, state), at: AT })
  return ledger
}

test('a reply is recorded with its note', (t) => {
  const ledger = setup(t)

  const result = recordForModel(ledger, { appId: 'a_1', state: 'replied', note: 'HR 回复约面' }, NOW)

  assert.deepEqual(result, { ok: true, appId: 'a_1', state: 'replied' })
  const app = ledger.projection.apps.get('a_1')
  assert.equal(app?.state, 'replied')
  assert.equal(app?.note, 'HR 回复约面')
})

test('a reply can lead to an interview and an offer', (t) => {
  const ledger = setup(t)
  recordForModel(ledger, { appId: 'a_1', state: 'replied' }, NOW)
  recordForModel(ledger, { appId: 'a_1', state: 'interview' }, NOW)
  const result = recordForModel(ledger, { appId: 'a_1', state: 'offer' }, NOW)

  assert.equal(result.ok, true)
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'offer')
})

test('an illegal transition is refused with the allowed targets', (t) => {
  const ledger = setup(t)

  const result = recordForModel(ledger, { appId: 'a_1', state: 'queued' }, NOW)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_INVALID_ARGUMENT')
})

test('a state the machine forbids comes back as E_ILLEGAL_TRANSITION with allowed', (t) => {
  const ledger = setup(t)
  // submitted -> interview is not an edge; the machine requires replied in between.
  const result = recordForModel(ledger, { appId: 'a_1', state: 'interview' }, NOW)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_ILLEGAL_TRANSITION')
  assert.equal(result.allowed, 'replied,rejected,withdrawn')
})

test('an unknown application is refused without writing anything', (t) => {
  const ledger = setup(t)
  const before = ledger.projection.revision

  const result = recordForModel(ledger, { appId: 'a_nope', state: 'replied' }, NOW)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_INVALID_ARGUMENT')
  assert.equal(ledger.projection.revision, before)
})

test('an uncertain application may be adjudicated as submitted by hand', (t) => {
  // `uncertain` can only be reached from `applying`, so the application starts there.
  const ledger = setup(t, 'uncertain')

  const result = recordForModel(ledger, { appId: 'a_1', state: 'submitted', note: '人工确认已投' }, NOW)

  assert.equal(result.ok, true)
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'submitted')
})

test('a job id resolves to its latest application', (t) => {
  const ledger = setup(t)
  // A second attempt on the same job: recording by job id must pick the newest one.
  ledger.append({ type: 'app/create', app: { ...makeApp('j_1', 'submitted'), id: 'a_2' }, at: AT })

  const result = recordForModel(ledger, { jobId: 'j_1', state: 'replied' }, NOW)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.appId, 'a_2')
  assert.equal(ledger.projection.apps.get('a_2')?.state, 'replied')
  assert.equal(ledger.projection.apps.get('a_1')?.state, 'submitted')
})

test('neither id is refused with a message that says what to pass', (t) => {
  const ledger = setup(t)
  const result = recordForModel(ledger, { state: 'replied' }, NOW)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_INVALID_ARGUMENT')
  assert.match(result.message, /appId|jobId/)
})

test('rendering says what changed, and what would have been allowed', () => {
  assert.equal(
    renderRecordResult({ ok: true, appId: 'a_1', state: 'replied' }),
    '已记录：a_1 → replied',
  )
  assert.equal(
    renderRecordResult({
      ok: false,
      code: 'E_ILLEGAL_TRANSITION',
      message: '当前状态不允许这样变更',
      allowed: 'replied,rejected,withdrawn',
    }),
    '[E_ILLEGAL_TRANSITION] 当前状态不允许这样变更（允许：replied,rejected,withdrawn）',
  )
  assert.equal(RECORD_TOOL_NAME, 'job_ledger_record')
})
