/**
 * Reading and updating one sheet of an `.xlsx` workbook, with no runtime dependency.
 *
 * The sheet is the user's, not ours: every row we do not touch stays byte-for-byte as it was, and a
 * matched row only has the mapped cells rewritten. That is why this works on the sheet XML instead
 * of rebuilding the file from a cell matrix — a rebuild would drop column widths, number formats
 * and formulas in the columns we never promised to touch.
 *
 * Scope is deliberately small: the first worksheet, inline/shared strings, plain numbers, and the
 * append/update path the tracker needs. Charts, pivot tables and multiple sheets are preserved
 * untouched because they are parts we never rewrite.
 *
 * @module dsh-job-ledger/tracker/xlsx
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import { readZip, writeZip } from './zip.ts'
import type { ZipEntry } from './zip.ts'

/** One row read from a sheet, as text. Empty cells are empty strings. */
export interface SheetRow {
  readonly values: readonly string[]
}

/** A sheet as the tracker sees it. */
export interface SheetData {
  /** Header cells, trimmed. */
  readonly header: readonly string[]
  /** Data rows aligned to `header`. */
  readonly rows: readonly SheetRow[]
}

/** What to write: mapped columns by their header names, in sheet order. */
export interface SheetWrite {
  readonly header: readonly string[]
  /** Column values, aligned to `header`. */
  readonly values: readonly string[]
  /** Columns that identify an existing row: company, title, city (by header name). */
  readonly keyHeaders: readonly string[]
}

/** The tracker's column names, in the order the plugin writes them (PRD §5.11). */
export const TRACKER_COLUMNS = ['公司', '职位', '城市', '薪资', '投递时间', '状态', '链接'] as const

/** Accepted spellings per column, so an existing sheet does not have to be renamed. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  公司: ['公司', '公司名称', '企业', '企业名称'],
  职位: ['职位', '岗位', '岗位名称', '职位名称'],
  城市: ['城市', '地点', '工作城市', 'Base地'],
  薪资: ['薪资', '薪水', '工资', '薪资范围'],
  投递时间: ['投递时间', '投递日期', '时间', '日期'],
  状态: ['状态', '进度', '结果'],
  链接: ['链接', '网址', '岗位链接', 'URL'],
}

/**
 * @param header header cell text @returns the tracker column it stands for, if any
 */
export function trackerColumn(header: string): string | undefined {
  const text = header.trim().replace(/\s+/g, '')
  for (const [column, names] of Object.entries(ALIASES)) if (names.includes(text)) return column
  return undefined
}

/**
 * @param header header row @returns column index by tracker column name
 */
export function headerIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>()
  header.forEach((cell, index) => {
    const column = trackerColumn(cell)
    if (column !== undefined && !map.has(column)) map.set(column, index)
  })
  return map
}

/** Escape text for XML content. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param column zero-based column index @returns the spreadsheet column name (A, B, ... AA) */
export function columnName(column: number): string {
  let name = ''
  let rest = column + 1
  while (rest > 0) {
    const digit = (rest - 1) % 26
    name = String.fromCharCode(65 + digit) + name
    rest = Math.floor((rest - 1) / 26)
  }
  return name
}

/** Decode the XML entities this module can encounter in cell text. */
function unescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** @param xml sharedStrings.xml @returns the shared strings in index order */
function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return []
  const strings: string[] = []
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const body = match[1] ?? ''
    const parts = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => unescape(part[1] ?? ''))
    strings.push(parts.join(''))
  }
  return strings
}

/** @param body cell inner XML @param shared shared strings @param type cell `t` attribute @returns text */
function cellText(body: string, shared: readonly string[], type: string | undefined): string {
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => unescape(part[1] ?? '')).join('')
  }
  const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (raw === undefined) return ''
  if (type === 's') return shared[Number(raw)] ?? ''
  return unescape(raw)
}

/** @param xml sheet xml @returns one entry per row, with its cells decoded @param shared shared strings */
function parseRows(xml: string, shared: readonly string[]): { xml: string; values: string[] }[] {
  const rows: { xml: string; values: string[] }[] = []
  for (const match of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const values: string[] = []
    for (const cell of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ''
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const index = ref === undefined ? values.length : columnIndex(ref)
      values[index] = cellText(cell[2] ?? '', shared, type)
    }
    for (let index = 0; index < values.length; index += 1) values[index] ??= ''
    rows.push({ xml: match[0], values })
  }
  return rows
}

/** @param letters column letters @returns zero-based index */
function columnIndex(letters: string): number {
  let index = 0
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

/** Where the first worksheet lives inside the archive. */
interface SheetLocation {
  readonly sheetName: string
  readonly path: string
}

/** @param entries archive entries @returns the first worksheet's name and part path */
function locateSheet(entries: readonly ZipEntry[]): SheetLocation {
  const workbook = entries.find((entry) => entry.name === 'xl/workbook.xml')?.data.toString('utf8')
  if (workbook === undefined) throw new Error('not an xlsx workbook: xl/workbook.xml is missing')
  const first = /<sheet\b([^>]*)\/?>/.exec(workbook)
  const name = first === null ? undefined : /\bname="([^"]*)"/.exec(first[1] ?? '')?.[1]
  const relId = first === null ? undefined : /\br:id="([^"]+)"/.exec(first[1] ?? '')?.[1]
  const rels = entries.find((entry) => entry.name === 'xl/_rels/workbook.xml.rels')?.data.toString('utf8')
  const target = relId === undefined || rels === undefined
    ? undefined
    : new RegExp(`<Relationship\\b[^>]*\\bId="${relId}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
  const path = target === undefined
    ? 'xl/worksheets/sheet1.xml'
    : target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`
  return { sheetName: unescape(name ?? 'Sheet1'), path }
}

/**
 * Read the first worksheet.
 *
 * @param path xlsx path
 * @returns header and data rows
 * @throws Error when the file is not an xlsx workbook
 */
export function readSheet(path: string): SheetData {
  const entries = readZip(readFileSync(path))
  const { path: sheetPath } = locateSheet(entries)
  const xml = entries.find((entry) => entry.name === sheetPath)?.data.toString('utf8')
  if (xml === undefined) throw new Error(`xlsx has no worksheet at ${sheetPath}`)
  const shared = parseSharedStrings(entries.find((entry) => entry.name === 'xl/sharedStrings.xml')?.data.toString('utf8'))
  const rows = parseRows(xml, shared)
  const header = (rows[0]?.values ?? []).map((value) => value.trim())
  return { header, rows: rows.slice(1).map((row) => ({ values: row.values })) }
}

/** Replace the text of one cell inside a row's XML, keeping everything else on that row. */
function setCell(rowXml: string, column: number, text: string): string {
  const letters = columnName(column)
  const pattern = new RegExp(`<c\\b([^>]*?\\br="${letters}\\d+"[^>]*?)(?:/>|>([\\s\\S]*?)</c>)`)
  const match = pattern.exec(rowXml)
  const inline = `<is><t xml:space="preserve">${escape(text)}</t></is>`

  if (match === null) {
    // No cell there yet: append one at the end of the row. Excel tolerates out-of-order cells.
    return rowXml.replace(/<\/row>$/, `<c r="${letters}${rowNumber(rowXml)}" t="inlineStr">${inline}</c></row>`)
  }

  const attrs = (match[1] ?? '').replace(/\s*\bt="[^"]*"/g, '')
  const replacement = `<c${attrs} t="inlineStr">${inline}</c>`
  return rowXml.slice(0, match.index) + replacement + rowXml.slice(match.index + match[0].length)
}

/** @param rowXml row xml @returns its row number, or 1 when absent */
function rowNumber(rowXml: string): number {
  const number = /\br="(\d+)"/.exec(rowXml.slice(0, rowXml.indexOf('>')))?.[1]
  return number === undefined ? 1 : Number(number)
}

/** Build a row element for values that did not exist yet, borrowing styles from a reference row. */
function buildRow(index: number, values: readonly string[], reference: string | undefined): string {
  const styleOf = (column: number): string | undefined => {
    if (reference === undefined) return undefined
    const letters = columnName(column)
    const match = new RegExp(`<c\\b([^>]*?\\br="${letters}\\d+"[^>]*?)(?:/>|>)`).exec(reference)
    return match === null ? undefined : /\bs="(\d+)"/.exec(match[1] ?? '')?.[1]
  }
  const cells = values.map((value, column) => {
    if (value === '') return ''
    const style = styleOf(column)
    return `<c r="${columnName(column)}${index}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`
  }).join('')
  return `<row r="${index}">${cells}</row>`
}

/** What a batch of upserts did. */
export interface UpsertResult {
  readonly updated: number
  readonly appended: number
}

/** Apply one write to the parsed rows, matching on the key columns. */
function applyWrite(
  rows: { xml: string; values: string[] }[],
  columns: Map<string, number>,
  write: SheetWrite,
): 'updated' | 'appended' {
  const valueOf = (name: string): string => {
    const index = write.header.indexOf(name)
    return index === -1 ? '' : write.values[index] ?? ''
  }
  const keys = write.keyHeaders.map((name) => {
    const index = columns.get(name)
    if (index === undefined) throw new Error(`the sheet has no 「${name}」 column`)
    return { name, index }
  })
  const matches = (cells: readonly string[]): boolean =>
    keys.every(({ name, index }) => (cells[index] ?? '').trim() === valueOf(name).trim())

  const target = rows.slice(1).findIndex((row) => matches(row.values))
  if (target !== -1) {
    const rowIndex = target + 1
    const row = rows[rowIndex]!
    let xml = row.xml
    const values = [...row.values]
    for (const [name, index] of columns) {
      const value = valueOf(name)
      if (value === '') continue
      xml = setCell(xml, index, value)
      values[index] = value
    }
    rows[rowIndex] = { ...row, xml, values }
    return 'updated'
  }

  const last = rows.at(-1)
  rows.push({ xml: buildRow(rows.length + 1, write.values, last?.xml), values: [...write.values] })
  return 'appended'
}

/**
 * Upsert rows in the first worksheet.
 *
 * A row whose key columns match an existing one has only the mapped cells rewritten; otherwise a
 * new row is appended, borrowing the last data row's cell styles. Everything else in the archive is
 * copied through unchanged, and the file is replaced atomically.
 *
 * @param path xlsx path
 * @param writes rows to write
 * @returns how many rows were updated and appended
 * @throws Error when the file is not an xlsx workbook or the sheet lacks a key column
 */
export function upsertSheetRows(path: string, writes: readonly SheetWrite[]): UpsertResult {
  const buffer = readFileSync(path)
  const entries = readZip(buffer)
  const { path: sheetPath } = locateSheet(entries)
  const sheetEntry = entries.find((entry) => entry.name === sheetPath)
  if (sheetEntry === undefined) throw new Error(`xlsx has no worksheet at ${sheetPath}`)
  const xml = sheetEntry.data.toString('utf8')
  const shared = parseSharedStrings(entries.find((entry) => entry.name === 'xl/sharedStrings.xml')?.data.toString('utf8'))
  const rows = parseRows(xml, shared)
  if (rows.length === 0) throw new Error('the sheet is empty: the first row must be a header')
  const header = (rows[0]?.values ?? []).map((value) => value.trim())
  // Canonical tracker columns («职位» stands for 岗位/职位/…), so one write works on any spelling.
  const columns = headerIndex(header)

  let updated = 0
  let appended = 0
  for (const write of writes) {
    if (applyWrite(rows, columns, write) === 'updated') updated += 1
    else appended += 1
  }

  const start = xml.indexOf('<sheetData')
  const end = xml.indexOf('</sheetData>')
  if (start === -1 || end === -1) throw new Error('the worksheet has no sheetData')
  const width = Math.max(0, ...rows.map((row) => row.values.length)) - 1
  const dimension = `<dimension ref="A1:${columnName(Math.max(width, 0))}${rows.length}"/>`
  const before = xml.slice(0, start).replace(/<dimension\b[^>]*\/?>/, dimension)
  const body = rows.map((row) => row.xml).join('')
  const next = `${before}<sheetData>${body}</sheetData>${xml.slice(end + '</sheetData>'.length)}`

  const replaced = entries.map((entry) =>
    entry.name === sheetPath ? { name: entry.name, data: Buffer.from(next, 'utf8') } : entry,
  )
  // Write next to the original and rename, so a crash never leaves half a workbook behind.
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, writeZip(replaced))
  renameSync(temporary, path)
  return { updated, appended }
}

/**
 * Upsert one row.
 *
 * @param path xlsx path
 * @param write the row
 * @returns `true` when an existing row was updated
 */
export function upsertSheetRow(path: string, write: SheetWrite): boolean {
  return upsertSheetRows(path, [write]).updated > 0
}
