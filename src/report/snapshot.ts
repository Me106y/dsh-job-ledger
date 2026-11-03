/**
 * Weekly human-readable snapshot (TECH §6.6).
 *
 * The ledger is the source of truth; this file is a convenience for the user, so it can be opened,
 * mailed to themselves, or diffed over time. It is written `0600`: it contains the same data the
 * ledger does.
 *
 * @module dsh-job-ledger/report/snapshot
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Projection } from '../ledger/project.ts'
import { PluginError } from '../shared/errors.ts'
import { buildReport, reportMarkdown } from './build.ts'

/** Snapshot file name inside the data directory. */
export const SNAPSHOT_FILE = 'snapshot.md'

/** Marker holding the ISO week of the last automatic snapshot. */
export const SNAPSHOT_WEEK_FILE = 'snapshot-week'

/**
 * Write the Markdown report next to the ledger.
 *
 * @param dataDir ledger directory @param markdown rendered report @returns the absolute path
 * @throws PluginError `E_LEDGER_WRITE` when it cannot be written
 */
export function saveSnapshot(dataDir: string, markdown: string): string {
  const path = join(dataDir, SNAPSHOT_FILE)
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(path, markdown, { mode: 0o600 })
  } catch (error) {
    throw new PluginError('E_LEDGER_WRITE', { what: `snapshot: ${String(error)}` })
  }
  return path
}

/**
 * ISO week of a timestamp, e.g. `2026-W45`.
 *
 * @param now epoch ms @returns the week key
 */
export function isoWeek(now: number): string {
  const date = new Date(now)
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay()
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${String(thursday.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

/**
 * Whether this week's snapshot has not been written yet.
 *
 * @param dataDir ledger directory @param now epoch ms @returns true when it is due
 */
export function snapshotDue(dataDir: string, now: number): boolean {
  try {
    const last = readFileSync(join(dataDir, SNAPSHOT_WEEK_FILE), 'utf8').trim()
    return last !== isoWeek(now)
  } catch {
    return true
  }
}

/**
 * Write the weekly snapshot once per ISO week.
 *
 * A failure to write is reported through the same `E_LEDGER_WRITE` path as any other disk problem;
 * the marker is written after the snapshot, so a failed write is retried next time.
 *
 * @param dataDir ledger directory
 * @param projection ledger state
 * @param now epoch ms
 * @returns whether it wrote, and where
 */
export function weeklySnapshot(
  dataDir: string,
  projection: Projection,
  now: number,
): { readonly written: boolean; readonly path?: string } {
  if (!snapshotDue(dataDir, now)) return { written: false }

  const markdown = reportMarkdown(buildReport(projection, now))
  const path = saveSnapshot(dataDir, markdown)
  try {
    writeFileSync(join(dataDir, SNAPSHOT_WEEK_FILE), isoWeek(now), { mode: 0o600 })
  } catch (error) {
    throw new PluginError('E_LEDGER_WRITE', { what: `snapshot marker: ${String(error)}` })
  }
  return { written: true, path }
}
