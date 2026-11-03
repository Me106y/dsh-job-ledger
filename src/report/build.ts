/**
 * Funnel, source and weekly report (PRD §5.8, TECH §10.4).
 *
 * Two rules make the numbers trustworthy:
 * - **Backfill is excluded.** Reconcile-backfill rows have no follow-up state, so counting them
 *   would inflate the funnel with applications nobody ever answered (PRD §5.7).
 * - **A stage counts if it was ever reached**, not if it is the current state. A rejected
 *   application was still a reply, and reading it as "no reply" would understate the channel that
 *   actually worked.
 *
 * The conclusion sentence is generated from a template, deterministically. The model may rewrite
 * it later (TECH §8.2), but it may not rewrite the numbers.
 *
 * @module dsh-job-ledger/report/build
 */

import type { AppState } from '../ledger/events.ts'
import type { Projection } from '../ledger/project.ts'
import { ATTEMPTED_STATES } from '../ledger/project.ts'

/** Funnel counts and stage-to-stage conversion rates (0–1). */
export interface Funnel {
  readonly applied: number
  readonly replied: number
  readonly interview: number
  readonly offer: number
  readonly replyRate: number
  readonly interviewRate: number
  readonly offerRate: number
}

/** One row per application source. */
export interface SourceRow {
  readonly source: string
  readonly applied: number
  readonly replied: number
  readonly replyRate: number
}

/** One row per ISO week. */
export interface WeekRow {
  readonly weekStart: string
  readonly applied: number
}

/** Everything the panel and the Markdown export need. */
export interface Report {
  readonly generatedAt: string
  readonly funnel: Funnel
  readonly sources: readonly SourceRow[]
  readonly weekly: readonly WeekRow[]
  /** Backfilled applications left out of every number above. */
  readonly excludedBackfill: number
  readonly conclusion: string
}

const WEEK_MS = 7 * 86_400_000

/** @param part smaller count @param whole larger count @returns part/whole, or 0 when whole is 0 */
function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

/** @param date date @returns the Monday 00:00 UTC of that date's week, as `YYYY-MM-DD` */
function weekStartOf(date: Date): string {
  const day = date.getUTCDay()
  const offset = (day + 6) % 7 // Monday = 0
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - offset)
  return monday.toISOString().slice(0, 10)
}

/**
 * Build the report.
 *
 * @param projection ledger state
 * @param now epoch ms, injected so the report is reproducible in tests
 * @returns funnel, per-source, weekly, and one sentence of conclusion
 */
export function buildReport(projection: Projection, now: number): Report {
  const all = [...projection.apps.values()]
  const counted = all.filter((app) => app.source !== 'reconcile-backfill')
  const excludedBackfill = all.length - counted.length

  /** @param appId application @param states states to test @returns whether any was ever reached */
  const reachedAny = (appId: string, states: readonly AppState[]): boolean => {
    const set = projection.reached.get(appId)
    return set !== undefined && states.some((state) => set.has(state))
  }

  const applied = counted.filter((app) => reachedAny(app.id, ATTEMPTED_STATES))
  const replied = applied.filter((app) => reachedAny(app.id, ['replied', 'interview', 'offer']))
  const interview = applied.filter((app) => reachedAny(app.id, ['interview', 'offer']))
  const offer = applied.filter((app) => reachedAny(app.id, ['offer']))

  const funnel: Funnel = {
    applied: applied.length,
    replied: replied.length,
    interview: interview.length,
    offer: offer.length,
    replyRate: ratio(replied.length, applied.length),
    interviewRate: ratio(interview.length, applied.length),
    offerRate: ratio(offer.length, applied.length),
  }

  const bySource = new Map<string, { applied: number; replied: number }>()
  for (const app of applied) {
    const row = bySource.get(app.source) ?? { applied: 0, replied: 0 }
    row.applied += 1
    if (reachedAny(app.id, ['replied', 'interview', 'offer'])) row.replied += 1
    bySource.set(app.source, row)
  }
  const sources: SourceRow[] = [...bySource.entries()]
    .map(([source, row]) => ({
      source,
      applied: row.applied,
      replied: row.replied,
      replyRate: ratio(row.replied, row.applied),
    }))
    .sort((left, right) => right.applied - left.applied || left.source.localeCompare(right.source))

  const thisWeek = weekStartOf(new Date(now))
  const thisWeekMs = Date.parse(`${thisWeek}T00:00:00.000Z`)
  const weekly: WeekRow[] = []
  for (let index = 7; index >= 0; index -= 1) {
    const start = new Date(thisWeekMs - index * WEEK_MS).toISOString().slice(0, 10)
    const end = thisWeekMs - (index - 1) * WEEK_MS
    const count = applied.filter((app) => {
      const at = Date.parse(app.createdAt)
      return at >= Date.parse(`${start}T00:00:00.000Z`) && at < end
    }).length
    weekly.push({ weekStart: start, applied: count })
  }

  return {
    generatedAt: new Date(now).toISOString(),
    funnel,
    sources,
    weekly,
    excludedBackfill,
    conclusion: conclude(applied.length, sources),
  }
}

/**
 * One actionable sentence, or an honest "not enough data yet".
 *
 * @param appliedCount total applications counted
 * @param sources per-source rows
 * @returns the conclusion line
 */
function conclude(appliedCount: number, sources: readonly SourceRow[]): string {
  const best = [...sources]
    .filter((row) => row.applied >= 3)
    .sort((left, right) => right.replyRate - left.replyRate || right.applied - left.applied)[0]
  if (best === undefined) {
    return appliedCount === 0
      ? '还没有可统计的投递。投出第一批 10 个岗位后再看来源差异。'
      : `样本不足（已投 ${String(appliedCount)} 条），先积累 10 条投递再比较来源。`
  }
  const percent = `${(best.replyRate * 100).toFixed(1)}%`
  return `${best.source} 来源回复率最高（${percent}，共 ${String(best.applied)} 条），建议加投。`
}

/**
 * Render the report as Markdown, the export format PRD §5.8 requires.
 *
 * @param report built report
 * @returns Markdown with three tables and the conclusion
 */
export function reportMarkdown(report: Report): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
  const lines: string[] = [
    `# 投递报表 · ${report.generatedAt.slice(0, 10)}`,
    '',
    `> ${report.conclusion}`,
    '',
    '## 漏斗',
    '',
    '| 阶段 | 数量 | 占投递 |',
    '|---|---:|---:|',
    `| 投递 | ${String(report.funnel.applied)} | 100.0% |`,
    `| 回复 | ${String(report.funnel.replied)} | ${percent(report.funnel.replyRate)} |`,
    `| 面试 | ${String(report.funnel.interview)} | ${percent(report.funnel.interviewRate)} |`,
    `| offer | ${String(report.funnel.offer)} | ${percent(report.funnel.offerRate)} |`,
    '',
    '## 来源',
    '',
    '| 来源 | 投递 | 回复 | 回复率 |',
    '|---|---:|---:|---:|',
    ...report.sources.map(
      (row) =>
        `| ${row.source} | ${String(row.applied)} | ${String(row.replied)} | ${percent(row.replyRate)} |`,
    ),
    '',
    '## 周趋势',
    '',
    '| 周 | 投递 |',
    '|---|---:|',
    ...report.weekly.map((row) => `| ${row.weekStart} | ${String(row.applied)} |`),
    '',
  ]
  if (report.excludedBackfill > 0) {
    lines.push(
      `> 另有 ${String(report.excludedBackfill)} 条回填数据未计入：回填没有后续状态，计入会污染漏斗。`,
      '',
    )
  }
  return lines.join('\n')
}
