import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../../src/ledger/store.ts'
import {
  alignWrite,
  readTracker,
  resolveTrackerPath,
  shortDate,
  trackerRow,
  writeTrackerRows,
} from '../../src/tracker/sheet.ts'
import { importSheetHistory, parseSheetDate, syncTracker } from '../../src/tracker/sync.ts'
import { makeXlsx } from '../fixtures/xlsx.ts'
import { makeApp, makeJob } from '../fixtures/helpers.ts'

const NOW = Date.parse('2026-11-04T10:00:00.000Z')
const AT = new Date(NOW).toISOString()

/** @param t test context @returns a temp dir and an open ledger inside it */
function workspace(t: { after(fn: () => void): void }): { dir: string; ledger: Ledger } {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-sync-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = Ledger.open(join(dir, 'events.jsonl'))
  t.after(() => ledger.close())
  return { dir, ledger }
}

/** @param dir temp dir @param header sheet header @param rows sheet rows @returns the sheet path */
function sheet(dir: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
  const path = join(dir, 'tracker.xlsx')
  writeFileSync(path, makeXlsx(header, rows))
  return path
}

test('a short date keeps the month and day the sheet shows', () => {
  const parsed = parseSheetDate('9.22', NOW)
  assert.ok(parsed !== undefined)
  // Local calendar date: a sheet date has no timezone, and the ledger only needs the ordering.
  assert.equal(new Date(parsed).getMonth(), 8)
  assert.equal(new Date(parsed).getDate(), 22)
  assert.equal(parseSheetDate('2026-08-01', NOW), '2026-08-01T00:00:00.000Z')
  assert.equal(parseSheetDate('', NOW), undefined)
  assert.equal(shortDate('2026-11-04T10:00:00.000Z'), '11.4')
})

test('a canonical row is translated to the sheet\'s own column labels', () => {
  const write = trackerRow(
    makeJob({ id: 'j_1', company: '美团', title: '后端工程师', city: '上海' }),
    makeApp('j_1', 'submitted'),
  )
  const aligned = alignWrite(write, ['公司', '岗位', '链接', 'Base地', '投递日期', '状态'])
  assert.deepEqual(aligned?.keyHeaders, ['公司', '岗位', 'Base地'])
  assert.deepEqual(aligned?.values.slice(0, 3), ['美团', '后端工程师', '上海'])
  assert.equal(aligned?.values[4], '已投')
  // No company/role pair means no safe key: the row is dropped rather than duplicated.
  assert.equal(alignWrite(write, ['公司', 'Base地']), undefined)
})

test('history read from the sheet becomes dedupe-only applications', async (t) => {
  const { dir, ledger } = workspace(t)
  const path = sheet(dir, ['公司', '岗位', 'Base地', '投递日期', '状态'], [['美团', '后端工程师', '上海', '9.22', '面试']])

  const data = await readTracker(path)
  const result = importSheetHistory(ledger, data.header, data.rows.map((row) => row.values), NOW)

  assert.equal(result.imported, 1)
  const [app] = [...ledger.projection.apps.values()]
  assert.equal(app?.source, 'reconcile-backfill')
  assert.equal(app?.state, 'submitted')
  // A second pass matches instead of importing again.
  const again = importSheetHistory(ledger, data.header, data.rows.map((row) => row.values), NOW)
  assert.deepEqual(again, { imported: 0, matched: 1 })
  assert.equal(ledger.projection.apps.size, 1)
})

test('one sync imports the sheet and writes the ledger\'s own application back', async (t) => {
  const { dir, ledger } = workspace(t)
  const path = sheet(dir, ['公司', '岗位', 'Base地', '投递日期', '状态'], [['快手', 'AI 全栈', '北京', '9.20', '简历挂']])
  const job = makeJob({ id: 'j_1', company: '美团', title: '后端工程师', city: '上海' })
  ledger.append({ type: 'job/add', job, at: AT })
  ledger.append({ type: 'app/create', app: makeApp(job.id, 'submitted'), at: AT })

  const result = await syncTracker(ledger, path, NOW)

  assert.deepEqual(result, { imported: 1, matched: 0, written: 1 })
  const data = await readTracker(path)
  assert.equal(data.rows.length, 2)
  const written = data.rows.find((row) => row.values[0] === '美团')
  assert.ok(written !== undefined)
  assert.deepEqual(written?.values.slice(0, 3), ['美团', '后端工程师', '上海'])
})

test('a sheet write leaves rows it does not own untouched', async (t) => {
  const { dir, ledger } = workspace(t)
  const path = sheet(dir, ['公司', '岗位', 'Base地', '状态'], [['美团', '后端工程师', '上海', '网申成功']])
  const job = makeJob({ id: 'j_1', company: '美团', title: '后端工程师', city: '上海' })
  ledger.append({ type: 'job/add', job, at: AT })

  const result = await writeTrackerRows(path, [trackerRow(job, makeApp(job.id, 'submitted'))])

  assert.deepEqual(result, { updated: 1, appended: 0 })
  assert.equal((await readTracker(path)).rows[0]?.values[3], '已投')
})

test('a path without an extension resolves to the sheet that exists', async (t) => {
  const { dir } = workspace(t)
  const path = join(dir, '投递进度表.xlsx')
  writeFileSync(path, makeXlsx(['公司', '岗位', 'Base地'], []))

  const resolved = resolveTrackerPath(join(dir, '投递进度表'))

  assert.equal(resolved.path, path)
  assert.equal(resolved.format, 'xlsx')
  assert.throws(() => resolveTrackerPath(join(dir, '不存在')), { code: 'E_TRACKER_PATH' })
})
