import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginError } from '../../src/shared/errors.ts'
import { EVENT_VERSION } from '../../src/ledger/events.ts'
import type { EventInput } from '../../src/ledger/events.ts'
import { LEDGER_FILE, Ledger, MAX_LINE_BYTES, replay } from '../../src/ledger/store.ts'
import { AT, makeApp, makeJob } from '../fixtures/helpers.ts'

/** @param t test context @returns a temp directory removed after the test */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param dir temp dir @returns the ledger path inside it */
function ledgerPath(dir: string): string {
  return join(dir, LEDGER_FILE)
}

/** @param event like an append input @returns its on-disk line */
function line(event: EventInput): string {
  return `${JSON.stringify({ ...event, v: EVENT_VERSION, at: AT })}\n`
}

test('append survives a reopen', (t) => {
  const file = ledgerPath(tempDir(t))
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })

  const ledger = Ledger.open(file)
  ledger.append({ type: 'job/add', job })
  ledger.close()

  const reopened = Ledger.open(file)
  try {
    assert.equal(reopened.projection.jobs.size, 1)
    assert.equal(reopened.report.appliedLines, 1)
    assert.equal(reopened.report.truncatedAt, undefined)
  } finally {
    reopened.close()
  }
})

test('a corrupt tail stops replay, is truncated, and does not block the next append', (t) => {
  const file = ledgerPath(tempDir(t))
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  writeFileSync(file, `${line({ type: 'job/add', job })}  {"v":1,"at":"2026-1`)

  const ledger = Ledger.open(file)
  try {
    assert.equal(ledger.report.truncatedAt, 1)
    assert.equal(ledger.projection.jobs.size, 1)
    ledger.append({ type: 'job/status', jobId: job.id, status: 'queued' })
  } finally {
    ledger.close()
  }

  const reopened = Ledger.open(file)
  try {
    assert.equal(reopened.report.truncatedAt, undefined)
    assert.equal(reopened.projection.jobs.size, 1)
    assert.equal(reopened.projection.jobs.get(job.id)?.status, 'queued')
  } finally {
    reopened.close()
  }
})

test('an unknown event type is counted, not fatal', () => {
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  const raw = Buffer.from(
    `${line({ type: 'job/add', job })}{"v":1,"at":"${AT}","type":"future/thing"}\n`,
  )
  const result = replay(raw)
  assert.equal(result.appliedLines, 2)
  assert.equal(result.unknownTypes, 1)
  assert.equal(result.projection.unknownEvents, 1)
  assert.equal(result.projection.jobs.size, 1)
  assert.equal(result.truncatedAt, undefined)
})

test('a newer schema refuses to load instead of guessing', () => {
  const raw = Buffer.from(`{"v":2,"at":"${AT}","type":"job/add"}\n`)
  assert.throws(
    () => replay(raw),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_VERSION')
      return true
    },
  )
})

test('an event missing a required field is a coded error naming the line', () => {
  const raw = Buffer.from(`{"v":1,"at":"${AT}","type":"job/add"}\n`)
  assert.throws(
    () => replay(raw),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_STATE')
      assert.match(error.message, /line 1 is a job\/add event without job/)
      return true
    },
  )
})

test('a semantic violation during replay keeps its own code', () => {
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  const app = makeApp(job.id, 'submitted')
  const raw = Buffer.from(
    `${line({ type: 'job/add', job })}${line({ type: 'app/create', app })}${line({ type: 'app/state', appId: app.id, state: 'queued' })}\n`,
  )

  assert.throws(
    () => replay(raw),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_ILLEGAL_TRANSITION')
      return true
    },
  )
})

test('blank lines are tolerated', () => {
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  const raw = Buffer.from(`\n${line({ type: 'job/add', job })}\n\n`)
  const result = replay(raw)
  assert.equal(result.projection.jobs.size, 1)
  assert.equal(result.truncatedAt, undefined)
})

test('an event over the line cap is refused before it reaches the disk', (t) => {
  const file = ledgerPath(tempDir(t))
  const ledger = Ledger.open(file)
  try {
    const huge = makeJob({
      company: '字节跳动',
      title: '后端工程师',
      city: '深圳',
      jd: 'x'.repeat(MAX_LINE_BYTES),
    })
    assert.throws(
      () => ledger.append({ type: 'job/add', job: huge }),
      (error: unknown) => {
        assert.ok(error instanceof PluginError)
        assert.equal(error.code, 'E_LEDGER_WRITE')
        return true
      },
    )
    assert.equal(ledger.projection.jobs.size, 0)
  } finally {
    ledger.close()
  }
  assert.equal(statSync(file).size, 0)
})

test('an illegal transition never lands on disk', (t) => {
  const file = ledgerPath(tempDir(t))
  const ledger = Ledger.open(file)
  try {
    const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
    ledger.append({ type: 'job/add', job })
    ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted') })

    assert.throws(
      () => ledger.append({ type: 'app/state', appId: 'a_1', state: 'queued' }),
      (error: unknown) => {
        assert.ok(error instanceof PluginError)
        assert.equal(error.code, 'E_ILLEGAL_TRANSITION')
        return true
      },
    )
    assert.equal(ledger.projection.apps.get('a_1')?.state, 'submitted')
  } finally {
    ledger.close()
  }

  const reopened = Ledger.open(file)
  try {
    assert.equal(reopened.report.appliedLines, 2)
  } finally {
    reopened.close()
  }
})

test('a log that ends mid-line gets a newline before the next event', (t) => {
  const file = ledgerPath(tempDir(t))
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  // Valid event, but the crash happened before the terminating newline.
  writeFileSync(file, line({ type: 'job/add', job }).trimEnd())

  const ledger = Ledger.open(file)
  try {
    ledger.append({ type: 'job/status', jobId: job.id, status: 'queued' })
  } finally {
    ledger.close()
  }

  const reopened = Ledger.open(file)
  try {
    assert.equal(reopened.report.appliedLines, 2)
    assert.equal(reopened.projection.jobs.get(job.id)?.status, 'queued')
  } finally {
    reopened.close()
  }
})

test('appending after close is refused instead of silently dropped', (t) => {
  const ledger = Ledger.open(ledgerPath(tempDir(t)))
  ledger.close()
  assert.throws(
    () => ledger.append({ type: 'job/status', jobId: 'j_x', status: 'queued' }),
    (error: unknown) => {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, 'E_LEDGER_WRITE')
      return true
    },
  )
})

test('the ledger file is valid JSONL after a reopen', (t) => {
  const file = ledgerPath(tempDir(t))
  const ledger = Ledger.open(file)
  const job = makeJob({ company: '字节跳动', title: '后端工程师', city: '深圳' })
  ledger.append({ type: 'job/add', job })
  ledger.append({ type: 'job/status', jobId: job.id, status: 'queued' })
  ledger.close()

  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 2)
  for (const raw of lines) assert.doesNotThrow(() => JSON.parse(raw))
})
