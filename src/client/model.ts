/**
 * Client-side logic that has nothing to do with React.
 *
 * Every decision the panel makes — how often to poll, whether a response is worth re-rendering,
 * which rows a filter keeps — lives here so it can be tested without a DOM. The components stay thin.
 *
 * @module dsh-job-ledger/client/model
 */

import type { OverviewView, QueueRowView, RunView } from '../api/contract.ts'

/** Poll cadence while a run is active (TECH §11.4). */
export const POLL_ACTIVE_MS = 1_000

/** Poll cadence when nothing is running. */
export const POLL_IDLE_MS = 5_000

/** Tabs of the panel (TECH §12.2). */
export const TABS = ['queue', 'overview', 'reconcile'] as const

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
