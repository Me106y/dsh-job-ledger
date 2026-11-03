/**
 * The `queue` tool: what is waiting, why it is waiting, and what was rejected.
 *
 * Read-only and synchronous — it reads the projection, so calling it cannot write anything or touch
 * the browser. The model uses it to answer "what can I apply to?"; the panel renders the same rows
 * from the same function (PRD §5.10: one source, no second set of rules).
 *
 * @module dsh-job-ledger/tools/queue
 */

import type { QueueFilter, QueueRow } from '../ledger/queue.ts'
import { QUEUE_LIMIT, queueRows, queueTotal } from '../ledger/queue.ts'
import type { Ledger } from '../ledger/store.ts'

/** Tool name as the model sees it. */
export const QUEUE_TOOL_NAME = 'job_ledger_queue'

/** Model-facing description. */
export const QUEUE_TOOL_DESCRIPTION =
  '读取待投清单：new=判为新岗位，suspect=疑似重复待人工裁决，filtered=被筛掉但可捞回的岗位。只读，不改状态。'

/** What the tool returns. */
export type QueueToolResult =
  | {
      readonly ok: true
      readonly filter: QueueFilter
      readonly total: number
      readonly rows: QueueRow[]
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Options the tool passes through. */
export interface QueueOptions {
  readonly filter?: QueueFilter | undefined
  readonly limit?: number | undefined
}

/**
 * Read the queue.
 *
 * @param ledger the open ledger
 * @param options filter and page size
 * @returns rows plus the uncapped total
 */
export function queueForModel(ledger: Ledger, options: QueueOptions = {}): QueueToolResult {
  const filter: QueueFilter = options.filter ?? 'new'
  const limit = Math.min(Math.max(options.limit ?? QUEUE_LIMIT, 1), QUEUE_LIMIT)

  return {
    ok: true,
    filter,
    total: queueTotal(ledger.projection, filter),
    rows: queueRows(ledger.projection, filter, limit),
  }
}

/**
 * Render the rows as the model reads them.
 *
 * @param result tool result
 * @returns one line per row, or an honest empty line
 */
export function renderQueueResult(result: QueueToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  if (result.rows.length === 0) {
    return result.filter === 'filtered'
      ? '没有可捞回的岗位。'
      : result.filter === 'suspect'
        ? '没有待裁决的疑似重复。'
        : '没有新岗位：今天发现的都已被判重或过滤。'
  }
  const lines = result.rows.map((row, index) => {
    const salary = row.salaryRaw === undefined ? '' : ` · ${row.salaryRaw}`
    const city = row.city === '' ? '' : ` · ${row.city}`
    return `${String(index + 1)}. ${row.company} · ${row.title}${city}${salary}（${row.reason}）`
  })
  lines.push(`共 ${String(result.total)} 条，显示 ${String(result.rows.length)} 条。`)
  return lines.join('\n')
}
