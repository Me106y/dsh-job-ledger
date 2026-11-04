/**
 * The `.numbers` adapter: Numbers has no writable public format, so the sheet is driven through
 * AppleScript (JXA) instead of being parsed.
 *
 * Two operations, both returning the same shapes as the xlsx adapter: read the first sheet, and
 * upsert one row. The document is opened only when it is not already open, and closed again after
 * the operation if we were the ones who opened it — the user's window is not ours to close.
 *
 * @module dsh-job-ledger/tracker/numbers
 */

import { execFile } from 'node:child_process'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'

import { PluginError } from '../shared/errors.ts'
import type { SheetData, SheetWrite } from './xlsx.ts'

const run = promisify(execFile)

/** How long Numbers may take to open a document and answer. */
const TIMEOUT_MS = 30_000

/** What the script prints; `error` is a failure phrase Numbers produced. */
interface ScriptResult {
  readonly error?: string
  readonly headers?: string[]
  readonly rows?: string[][]
  readonly added?: boolean
}

/**
 * @param path absolute path
 * @returns the document name Numbers shows, which is the file name without its extension
 */
function documentName(path: string): string {
  return basename(path, extname(path))
}

/**
 * Run one JXA script against Numbers.
 *
 * @param path workbook path
 * @param body script body, already assembled with its own path literal
 * @returns what the script printed
 * @throws PluginError `E_TRACKER_SHEET` when Numbers cannot be driven
 */
async function runScript(path: string, body: string): Promise<ScriptResult> {
  try {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', body], { timeout: TIMEOUT_MS })
    const parsed = JSON.parse(stdout.trim()) as ScriptResult
    if (parsed.error !== undefined) throw new PluginError('E_TRACKER_SHEET', { what: parsed.error })
    return parsed
  } catch (error) {
    if (error instanceof PluginError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new PluginError('E_TRACKER_SHEET', { what: `Numbers 不可用（${detail.split('\n')[0] ?? ''}）` })
  }
}

/** Shared preamble: open the document unless it is already open, and remember whether we did. */
function preamble(path: string): string {
  const literal = JSON.stringify(path)
  const name = JSON.stringify(documentName(path))
  return `
const numbers = Application("com.apple.Numbers")
numbers.includeStandardAdditions = true
const target = ${literal}
const name = ${name}
let opened = false
let doc = numbers.documents().find((item) => String(item.name()) === name)
if (!doc) { doc = numbers.open(Path(target)); opened = true }
const table = doc.sheets[0].tables[0]
`
}

/**
 * Read the first sheet of a Numbers document.
 *
 * @param path absolute path
 * @returns header and data rows
 * @throws PluginError `E_TRACKER_SHEET` when Numbers cannot be driven
 */
export async function readNumbers(path: string): Promise<SheetData> {
  const script = `${preamble(path)}
const headers = []
const width = table.columns.length
for (let c = 0; c < width; c++) headers.push(String(table.rows[0].cells[c].value() ?? ""))
const rows = []
for (let r = 1; r < table.rows.length; r++) {
  const values = []
  for (let c = 0; c < width; c++) values.push(String(table.rows[r].cells[c].value() ?? ""))
  rows.push(values)
}
if (opened) doc.close()
JSON.stringify({ headers, rows })
`
  const result = await runScript(path, script)
  return { header: result.headers ?? [], rows: (result.rows ?? []).map((values) => ({ values })) }
}

/**
 * Upsert one row of a Numbers document.
 *
 * @param path absolute path
 * @param write header, values and the key columns
 * @returns `true` when an existing row was updated, `false` when a row was appended
 * @throws PluginError `E_TRACKER_SHEET` when Numbers cannot be driven
 */
export async function upsertNumbers(path: string, write: SheetWrite): Promise<boolean> {
  const columns = JSON.stringify(write.header)
  const values = JSON.stringify(write.values)
  const keys = JSON.stringify(write.keyHeaders)
  const script = `${preamble(path)}
const columns = ${columns}
const values = ${values}
const keys = ${keys}
const width = table.columns.length
const headers = []
for (let c = 0; c < width; c++) headers.push(String(table.rows[0].cells[c].value() ?? "").trim())
const indexOf = (name) => headers.indexOf(name)
const keyIndexes = keys.map(indexOf).filter((index) => index >= 0)
if (keyIndexes.length !== keys.length) {
  if (opened) doc.close()
  JSON.stringify({ error: "表头缺少 " + keys.filter((k) => indexOf(k) < 0).join("/") })
} else {
  const cell = (row, column) => String(table.rows[row].cells[column].value() ?? "").trim()
  let target = -1
  for (let r = 1; r < table.rows.length; r++) {
    let same = true
    for (let k = 0; k < keyIndexes.length; k++) {
      const header = headers[keyIndexes[k]]
      const wanted = String(values[columns.indexOf(keys[k])] ?? "").trim()
      if (cell(r, keyIndexes[k]) !== wanted) { same = false; break }
    }
    if (same) { target = r; break }
  }
  let appended = false
  if (target === -1) {
    numbers.addRowBelow(table.rows[table.rows.length - 1])
    target = table.rows.length - 1
    appended = true
  }
  for (let c = 0; c < columns.length; c++) {
    const index = indexOf(columns[c])
    if (index >= 0 && String(values[c]) !== "") table.rows[target].cells[index].value = values[c]
  }
  doc.save()
  if (opened) doc.close()
  JSON.stringify({ added: appended })
}
`
  const result = await runScript(path, script)
  return result.added !== true
}
