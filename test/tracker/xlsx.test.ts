import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readZip } from '../../src/tracker/zip.ts'
import { readSheet, TRACKER_COLUMNS, trackerColumn, upsertSheetRows } from '../../src/tracker/xlsx.ts'
import type { SheetWrite } from '../../src/tracker/xlsx.ts'
import { makeXlsx } from '../fixtures/xlsx.ts'

/** @param t test context @returns a temp dir and a writer for workbook bytes */
function workspace(t: { after(fn: () => void): void }): {
  write(name: string, data: Buffer): string
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'job-ledger-tracker-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    write(name: string, data: Buffer): string {
      const path = join(dir, name)
      writeFileSync(path, data)
      return path
    },
  }
}

/** @param values row values @returns a canonical write */
function row(values: readonly string[]): SheetWrite {
  return { header: TRACKER_COLUMNS, values, keyHeaders: ['公司', '职位', '城市'] }
}

test('reads the first worksheet as a header plus rows', (t) => {
  const { write } = workspace(t)
  const path = write('sheet.xlsx', makeXlsx(['公司', '岗位', 'Base地'], [['快手', 'AI 全栈', '北京']]))

  const data = readSheet(path)

  assert.deepEqual(data.header, ['公司', '岗位', 'Base地'])
  assert.deepEqual(data.rows.map((entry) => entry.values), [['快手', 'AI 全栈', '北京']])
})

test('appends a row, borrowing styles, and leaves unrelated archive parts alone', (t) => {
  const { write } = workspace(t)
  const path = write('sheet.xlsx', makeXlsx(['公司', '岗位', 'Base地'], [['快手', 'AI 全栈', '北京']], [
    { name: 'docProps/app.xml', data: Buffer.from('<Properties>keep me</Properties>', 'utf8') },
  ]))

  const result = upsertSheetRows(path, [row(['美团', '后端', '上海', '', '11.4', '已投', 'https://x/1'])])

  assert.deepEqual(result, { updated: 0, appended: 1 })
  const data = readSheet(path)
  assert.equal(data.rows.length, 2)
  assert.deepEqual(data.rows[1]?.values.slice(0, 3), ['美团', '后端', '上海'])
  const extra = readZip(readFileSync(path)).find((entry) => entry.name === 'docProps/app.xml')
  assert.equal(extra?.data.toString('utf8'), '<Properties>keep me</Properties>')
})

test('updates the row whose company, role and city match, and appends for a new one', (t) => {
  const { write } = workspace(t)
  const path = write('sheet.xlsx', makeXlsx(['公司', '岗位', 'Base地', '状态'], [
    ['快手', 'AI 全栈', '北京', '简历挂'],
    ['美团', '后端', '上海', '待开启'],
  ]))

  const result = upsertSheetRows(path, [
    row(['快手', 'AI 全栈', '北京', '', '11.4', '已投', '']),
    row(['小红书', 'Agent', '杭州', '', '11.4', '已投', '']),
  ])

  assert.deepEqual(result, { updated: 1, appended: 1 })
  const data = readSheet(path)
  assert.equal(data.rows.length, 3)
  assert.equal(data.rows[0]?.values[3], '已投')
  assert.equal(data.rows[1]?.values[3], '待开启')
  assert.deepEqual(data.rows[2]?.values.slice(0, 3), ['小红书', 'Agent', '杭州'])
})

test('refuses a sheet without the key columns instead of appending blindly', (t) => {
  const { write } = workspace(t)
  const path = write('sheet.xlsx', makeXlsx(['公司', 'Base地'], [['快手', '北京']]))

  assert.throws(() => upsertSheetRows(path, [row(['美团', '后端', '上海'])]), /「职位」/)
})

test('recognises the column spellings an existing sheet already uses', () => {
  assert.equal(trackerColumn('公司'), '公司')
  assert.equal(trackerColumn('岗位'), '职位')
  assert.equal(trackerColumn('Base地'), '城市')
  assert.equal(trackerColumn('投递日期'), '投递时间')
  assert.equal(trackerColumn('备注'), undefined)
})
