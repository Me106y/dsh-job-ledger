import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../../src/ledger/store.ts'
import {
  SNAPSHOT_FILE,
  SNAPSHOT_WEEK_FILE,
  isoWeek,
  saveSnapshot,
  snapshotDue,
  weeklySnapshot,
} from '../../src/report/snapshot.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const NEXT_WEEK = NOW + 8 * 86_400_000

/** @param t test context @returns a temp directory */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** @param dir data directory @returns an open ledger inside it */
function ledgerIn(dir: string): Ledger {
  return Ledger.open(join(dir, 'events.jsonl'))
}

test('weeks are ISO weeks, and nearby dates share one', () => {
  assert.match(isoWeek(NOW), /^\d{4}-W\d{2}$/)
  assert.equal(isoWeek(NOW), isoWeek(NOW + 86_400_000))
  assert.notEqual(isoWeek(NOW), isoWeek(NEXT_WEEK))
})

test('a fresh directory is due; the same week afterwards is not', (t) => {
  const dir = tempDir(t)
  assert.equal(snapshotDue(dir, NOW), true)

  saveSnapshot(dir, '# report')
  writeFileSync(join(dir, SNAPSHOT_WEEK_FILE), isoWeek(NOW))

  assert.equal(snapshotDue(dir, NOW), false)
  assert.equal(snapshotDue(dir, NEXT_WEEK), true)
})

test('the weekly snapshot is written once per week', (t) => {
  const dir = tempDir(t)
  const ledger = ledgerIn(dir)
  t.after(() => ledger.close())

  const first = weeklySnapshot(dir, ledger.projection, NOW)
  const second = weeklySnapshot(dir, ledger.projection, NOW)

  assert.equal(first.written, true)
  assert.equal(second.written, false)
  assert.equal(first.path, join(dir, SNAPSHOT_FILE))
  assert.match(readFileSync(join(dir, SNAPSHOT_FILE), 'utf8'), /^# 投递报表/)
  assert.equal(statSync(join(dir, SNAPSHOT_WEEK_FILE)).mode & 0o777, 0o600)

  const next = weeklySnapshot(dir, ledger.projection, NEXT_WEEK)
  assert.equal(next.written, true)
})

test('a failed snapshot surfaces as a ledger write error', (t) => {
  const dir = tempDir(t)
  const ledger = ledgerIn(dir)
  t.after(() => ledger.close())
  const blocked = join(dir, 'events.jsonl')

  assert.throws(
    () => weeklySnapshot(blocked, ledger.projection, NOW),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'E_LEDGER_WRITE')
      return true
    },
  )
})
