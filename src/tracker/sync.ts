/**
 * Keeping the tracker sheet and the ledger in step (PRD §5.11).
 *
 * Two directions, one rule: the ledger stays the source of truth. Importing the sheet can only add
 * backfilled applications (they participate in dedupe and stay out of the funnel); writing the sheet
 * is a copy that may fail without touching a single application state.
 *
 * @module dsh-job-ledger/tracker/sync
 */

import type { DeliveredRow } from '../reconcile/parse.ts'
import { reconcile } from '../reconcile/boss.ts'
import type { Ledger } from '../ledger/store.ts'
import { readTracker, trackerRow, writeTrackerRows } from './sheet.ts'

/** What one sync did. */
export interface TrackerSync {
  /** Rows the sheet had and the ledger did not: written back as `reconcile-backfill`. */
  readonly imported: number
  /** Rows the sheet already had and the ledger also knew. */
  readonly matched: number
  /** Local applications written into the sheet. */
  readonly written: number
}

/** States whose application is worth showing in the sheet. */
const VISIBLE: ReadonlySet<string> = new Set([
  'submitted',
  'uncertain',
  'replied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'failed',
])

/**
 * Parse the date style the sheets use (`9.22`, `2026-09-22`).
 *
 * A short date has no year; the current year is the only defensible reading, and dedupe only needs
 * a plausible ordering.
 *
 * @param text cell text @param now epoch ms @returns ISO time, or undefined when it is not a date
 */
export function parseSheetDate(text: string, now: number): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const short = /^(\d{1,2})[./月-](\d{1,2})日?$/.exec(trimmed)
  if (short !== null) {
    const year = new Date(now).getFullYear()
    const date = new Date(year, Number(short[1]) - 1, Number(short[2]))
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/**
 * @param header sheet header @param row sheet row @param column canonical column @returns its text
 */
function cell(header: readonly string[], row: readonly string[], column: string): string {
  const aliases = COLUMN_ALIASES[column] ?? [column]
  const index = header.findIndex((name) => aliases.includes(name.trim()))
  return index === -1 ? '' : (row[index] ?? '').trim()
}

/** The few spellings the import can recognise without asking the user to rename a column. */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  公司: ['公司', '公司名称', '企业', '企业名称'],
  职位: ['职位', '岗位', '岗位名称', '职位名称'],
  城市: ['城市', '地点', '工作城市', 'Base地'],
  投递时间: ['投递时间', '投递日期', '时间', '日期'],
}

/**
 * Import the sheet's history into the ledger.
 *
 * Rows become `reconcile-backfill` applications: they block a re-apply through dedupe but are
 * excluded from the funnel (PRD §5.7, decision #15).
 *
 * @param ledger the single writer
 * @param header sheet header
 * @param rows sheet rows
 * @param now epoch ms
 * @returns what reconcile did with them
 */
export function importSheetHistory(
  ledger: Ledger,
  header: readonly string[],
  rows: readonly (readonly string[])[],
  now: number,
): { imported: number; matched: number } {
  const delivered: DeliveredRow[] = []
  for (const row of rows) {
    const company = cell(header, row, '公司')
    const title = cell(header, row, '职位')
    const city = cell(header, row, '城市')
    if (company === '' || title === '') continue
    const at = parseSheetDate(cell(header, row, '投递时间'), now)
    delivered.push({
      externalId: `sheet:${company}|${title}|${city}`,
      company,
      title,
      city,
      ...(at === undefined ? {} : { at }),
    })
  }
  if (delivered.length === 0) return { imported: 0, matched: 0 }
  const report = reconcile(ledger, delivered, { source: 'reconcile-backfill', now, partial: false })
  return { imported: report.backfilled, matched: report.matched }
}

/**
 * Sync both directions once.
 *
 * @param ledger the single writer
 * @param path tracker path
 * @param now epoch ms
 * @returns counts for the panel
 * @throws PluginError when the sheet cannot be read or written
 */
export async function syncTracker(ledger: Ledger, path: string, now: number): Promise<TrackerSync> {
  const data = await readTracker(path)
  const imported = importSheetHistory(ledger, data.header, data.rows.map((row) => row.values), now)

  const writes = [...ledger.projection.apps.values()]
    .filter((app) => app.source === 'applied' && VISIBLE.has(app.state))
    .flatMap((app) => {
      const job = ledger.projection.jobs.get(app.jobId)
      return job === undefined ? [] : [trackerRow(job, app)]
    })
  const written = writes.length === 0 ? { updated: 0, appended: 0 } : await writeTrackerRows(path, writes)

  return { imported: imported.imported, matched: imported.matched, written: written.updated + written.appended }
}
