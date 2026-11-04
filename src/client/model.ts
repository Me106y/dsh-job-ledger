/**
 * Client-side logic that has nothing to do with React.
 *
 * Every decision the panel makes — how often to poll, whether a response is worth re-rendering,
 * which rows a filter keeps — lives here so it can be tested without a DOM. The components stay thin.
 *
 * @module dsh-job-ledger/client/model
 */

import type { OverviewView, QueueRowView, RunView } from '../api/contract.ts'
import type { MessageKey } from './locales.ts'

/** Poll cadence while a run is active (TECH §11.4). */
export const POLL_ACTIVE_MS = 1_000

/** Poll cadence when nothing is running. */
export const POLL_IDLE_MS = 5_000

/** Tabs of the panel (TECH §12.2). */
export const TABS = ['queue', 'overview', 'reconcile', 'settings'] as const

/** One tab name. */
export type Tab = (typeof TABS)[number]

/**
 * How long to wait before the next poll.
 *
 * @param run current run state @returns milliseconds
 */
export function pollInterval(run: RunView | undefined): number {
  return run !== undefined && (run.state === 'running' || run.state === 'queued')
    ? POLL_ACTIVE_MS
    : POLL_IDLE_MS
}

/**
 * Whether a fresh payload differs from the one on screen.
 *
 * The server bumps `revision` on every applied event; an unchanged revision means the same data and
 * the same render (TECH §11.4).
 *
 * @param previous last shown revision @param next incoming revision @returns true when they differ
 */
export function isStale(previous: number | undefined, next: number): boolean {
  return previous !== next
}

/**
 * @param row queue row @returns the line shown under the title
 */
export function rowSubtitle(row: QueueRowView): string {
  const parts = [row.company, row.city]
  if (row.salary !== '') parts.push(row.salary)
  return parts.filter((part) => part !== '').join(' · ')
}

/**
 * @param rows queue rows @param selected selected job ids @returns rows still selected
 */
export function pruneSelection(
  rows: readonly QueueRowView[],
  selected: ReadonlySet<string>,
): Set<string> {
  const present = new Set(rows.map((row) => row.jobId))
  return new Set([...selected].filter((id) => present.has(id)))
}

/**
 * Toggle one job in the selection.
 *
 * @param selected current selection @param jobId job to flip @returns a new set
 */
export function toggleSelection(selected: ReadonlySet<string>, jobId: string): Set<string> {
  const next = new Set(selected)
  if (next.has(jobId)) next.delete(jobId)
  else next.add(jobId)
  return next
}

/**
 * Hide the rows a person just deleted until the next poll confirms them gone.
 *
 * Deletion writes a ledger event, but the queue payload on screen was rendered before it; without
 * this the row would flash back for up to one poll interval and look like the delete failed.
 *
 * @param rows rows from the last queue payload @param removed job ids deleted since that payload
 * @returns rows without those ids
 */
export function withoutRows(
  rows: readonly QueueRowView[],
  removed: ReadonlySet<string>,
): QueueRowView[] {
  return removed.size === 0 ? [...rows] : rows.filter((row) => !removed.has(row.jobId))
}


/**
 * @param view overview payload @returns the quota remainder, never negative
 */
export function remainingQuota(view: OverviewView): number {
  return Math.max(0, view.today.quota - view.today.submitted)
}

/**
 * @param state run state @returns the Chinese label shown on the run bar
 */
export function runLabel(state: RunView['state']): string {
  switch (state) {
    case 'idle':
      return '空闲'
    case 'queued':
      return '排队中'
    case 'running':
      return '投递中'
    case 'paused':
      return '已暂停'
    case 'halted':
      return '已熔断'
    case 'done':
      return '已完成'
    case 'done-with-errors':
      return '完成（有失败）'
  }
}

/** Decision codes that have a human label; anything else is shown as the raw code. */
const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  new: 'reasonNew',
  'same-posting': 'reasonSamePosting',
  'same-role-company': 'reasonSameRoleCompany',
  'cross-source-same-jd': 'reasonCrossSource',
  cooldown: 'reasonCooldown',
  'same-title-different-jd': 'reasonSameTitle',
  'company-blacklist': 'reasonCompanyBlacklist',
  'excluded-keyword': 'reasonExcludedKeyword',
  'city-mismatch': 'reasonCityMismatch',
  'job-type-mismatch': 'reasonJobType',
  'salary-below-floor': 'reasonSalaryFloor',
}

/**
 * Translate a decision code for the row tag.
 *
 * @param reason code from the ledger
 * @returns the locale key, or undefined when the code has no label yet
 */
export function reasonKey(reason: string): MessageKey | undefined {
  return REASON_KEYS[reason]
}

/** The locale key of a run state, so the status pill follows the host language. */
export const RUN_KEYS: Record<RunView['state'], MessageKey> = {
  idle: 'runIdle',
  queued: 'runQueued',
  running: 'runRunning',
  paused: 'runPaused',
  halted: 'runHalted',
  done: 'runDone',
  'done-with-errors': 'runDoneWithErrors',
}

/**
 * Whether a run is still moving, which decides the poll cadence and the status colour.
 *
 * @param view latest overview @returns true while queued or running
 */
export function runActive(view: OverviewView | undefined): boolean {
  return view?.run.state === 'running' || view?.run.state === 'queued'
}
