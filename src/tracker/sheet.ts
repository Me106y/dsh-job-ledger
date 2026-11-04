/**
 * The tracker sheet as a whole: which format a path is, reading it, and writing rows into it.
 *
 * The sheet is matched by the columns it actually has, not by ours: an existing `投递进度表` may call
 * the role 「岗位」 and the city 「Base地」, and it may have no salary column at all. `alignWrite` maps
 * the canonical columns (PRD §5.11) onto the sheet's own header once, and everything below works
 * with those exact names.
 *
 * @module dsh-job-ledger/tracker/sheet
 */

import { existsSync } from 'node:fs'
import { extname } from 'node:path'

import { expandHome } from '../config.ts'

import type { Application, Job } from '../ledger/events.ts'
import { PluginError } from '../shared/errors.ts'
import { readNumbers, upsertNumbers } from './numbers.ts'
import { readSheet, TRACKER_COLUMNS, trackerColumn, upsertSheetRows } from './xlsx.ts'
import type { SheetData, SheetWrite } from './xlsx.ts'

/** Formats the tracker accepts. */
export type TrackerFormat = 'xlsx' | 'numbers'

/** Columns that must exist before a row can be matched. */
export const TRACKER_KEY_COLUMNS = ['公司', '职位', '城市'] as const

/** What a batch write did. */
export interface TrackerWriteResult {
  readonly updated: number
  readonly appended: number
}

/**
 * @param path sheet path @returns its format, when the extension is one we support
 */
export function trackerFormat(path: string): TrackerFormat | undefined {
  const extension = extname(path).toLowerCase()
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.numbers') return 'numbers'
  return undefined
}

/** What a configured path resolved to. */
export interface ResolvedTrackerPath {
  readonly path: string
  readonly format: TrackerFormat
}

/**
 * Resolve the configured path to a file that exists.
 *
 * People write the path they see in Finder, which hides extensions: 「投递进度表」 is enough. The
 * direct path wins; otherwise `.xlsx` and `.numbers` are tried, and the resolved path is what gets
 * stored. `~` is expanded.
 *
 * @param input the setting
 * @returns the existing file and its format
 * @throws PluginError `E_TRACKER_PATH` when nothing matches
 */
export function resolveTrackerPath(input: string): ResolvedTrackerPath {
  const trimmed = input.trim()
  if (trimmed === '') throw new PluginError('E_TRACKER_PATH', { what: '路径为空' })
  const candidate = expandHome(trimmed)

  const direct = trackerFormat(candidate)
  if (direct !== undefined && existsSync(candidate)) return { path: candidate, format: direct }
  for (const extension of ['.xlsx', '.numbers'] as const) {
    const suffixed = `${candidate}${extension}`
    if (existsSync(suffixed)) {
      return { path: suffixed, format: extension === '.xlsx' ? 'xlsx' : 'numbers' }
    }
  }
  if (existsSync(candidate)) throw new PluginError('E_TRACKER_PATH', { what: '只支持 .xlsx 或 .numbers' })
  throw new PluginError('E_TRACKER_PATH', { what: '文件不存在，或不是 .xlsx / .numbers' })
}

/**
 * @param path the setting
 * @returns the format of the file it names
 * @throws PluginError `E_TRACKER_PATH` when it cannot be resolved
 */
export function assertTrackerPath(path: string): TrackerFormat {
  return resolveTrackerPath(path).format
}

/**
 * Read the tracker sheet.
 *
 * @param path configured path
 * @returns header and rows
 * @throws PluginError when the file cannot be read
 */
export async function readTracker(path: string): Promise<SheetData> {
  const resolved = resolveTrackerPath(path)
  try {
    return resolved.format === 'numbers' ? await readNumbers(resolved.path) : readSheet(resolved.path)
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('E_TRACKER_SHEET', { what: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Translate a canonical write into the sheet's own column names.
 *
 * @param write canonical row @param header the sheet's header row
 * @returns the write with this sheet's labels, or undefined when too few key columns exist
 */
export function alignWrite(write: SheetWrite, header: readonly string[]): SheetWrite | undefined {
  const actual = new Map<string, string>()
  for (const cell of header) {
    const column = trackerColumn(cell)
    if (column !== undefined && !actual.has(column)) actual.set(column, cell.trim())
  }

  const columns: string[] = []
  const values: string[] = []
  write.header.forEach((name, index) => {
    const label = actual.get(name)
    if (label === undefined) return
    columns.push(label)
    values.push(write.values[index] ?? '')
  })

  const keys = write.keyHeaders
    .map((name) => actual.get(name))
    .filter((label): label is string => label !== undefined)
  // Company and role are the identity; without both, appending blindly would duplicate rows.
  if (actual.get('公司') === undefined || actual.get('职位') === undefined) return undefined
  return { header: columns, values, keyHeaders: keys }
}

/**
 * Upsert rows into the tracker sheet.
 *
 * @param path configured path
 * @param writes canonical rows
 * @returns how many rows were updated and appended
 * @throws PluginError when the sheet cannot be read or written
 */
export async function writeTrackerRows(input: string, writes: readonly SheetWrite[]): Promise<TrackerWriteResult> {
  const resolved = resolveTrackerPath(input)
  const path = resolved.path
  const data = await readTracker(path)

  try {
    // Numbers matches on the sheet's own labels, so the canonical row is translated first; the
    // xlsx writer resolves the same aliases itself.
    if (trackerFormat(path) === 'numbers') {
      const aligned = writes
        .map((write) => alignWrite(write, data.header))
        .filter((write): write is SheetWrite => write !== undefined)
      let updated = 0
      let appended = 0
      for (const write of aligned) {
        if (await upsertNumbers(path, write)) updated += 1
        else appended += 1
      }
      return { updated, appended }
    }
    return upsertSheetRows(path, writes)
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('E_TRACKER_SHEET', { what: error instanceof Error ? error.message : String(error) })
  }
}

/** Chinese label per application state, used in the sheet's 状态 column. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  submitted: '已投',
  uncertain: '待确认',
  replied: '已回复',
  interview: '面试',
  offer: 'Offer',
  rejected: '已拒绝',
  withdrawn: '已撤回',
  failed: '失败',
}

/**
 * @param iso timestamp @returns the short date the sheet's other rows use (`11.4`)
 */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getMonth() + 1)}.${String(date.getDate())}`
}

/**
 * Build the canonical row for one application.
 *
 * @param job the posting @param app the application @returns the row to write
 */
export function trackerRow(job: Job, app: Application): SheetWrite {
  return {
    header: TRACKER_COLUMNS,
    values: [
      job.company,
      job.title,
      job.city,
      job.salaryRaw ?? '',
      shortDate(app.updatedAt),
      STATE_LABELS[app.state] ?? app.state,
      job.url ?? '',
    ],
    keyHeaders: [...TRACKER_KEY_COLUMNS],
  }
}
