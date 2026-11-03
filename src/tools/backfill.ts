/**
 * The `backfill` tool: import the platform's history on first install (PRD §5.7, TECH §10.4).
 *
 * Backfilled applications are marked `reconcile-backfill`: they participate in dedupe, so the first
 * discovery does not re-apply to jobs you already applied to months ago, but they stay out of the
 * funnel — they have no follow-up state and would otherwise drag every rate down.
 *
 * Only the first page is read, and the tool says so. Importing one page and implying "all history"
 * would be the kind of quiet lie the rest of this codebase refuses.
 *
 * @module dsh-job-ledger/tools/backfill
 */

import type { Ledger } from '../ledger/store.ts'
import { reconcile } from '../reconcile/boss.ts'
import { readDelivered } from '../reconcile/read.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const BACKFILL_TOOL_NAME = 'job_ledger_backfill'

/** Model-facing description. */
export const BACKFILL_TOOL_DESCRIPTION =
  '首次安装时导入平台的历史投递（只读最近一页），标为回填：参与判重、不计入报表。只读接口。'

/** What backfill did. */
export type BackfillToolResult =
  | {
      readonly ok: true
      readonly matched: number
      readonly backfilled: number
      readonly partial: boolean
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Knobs tests pin. */
export interface BackfillOptions {
  readonly now?: number | undefined
  readonly newId?: (() => string) | undefined
}

/**
 * Import the platform's history.
 *
 * @param provider browser access @param ledger the single writer @param options clock and ids
 * @returns counts, or a coded failure
 */
export async function backfillForModel(
  provider: ReaderProvider,
  ledger: Ledger,
  options: BackfillOptions = {},
): Promise<BackfillToolResult> {
  try {
    const reader = await provider.reader()
    const delivered = await readDelivered(reader)
    const report = reconcile(ledger, delivered.rows, {
      source: 'reconcile-backfill',
      partial: delivered.partial,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    })
    return {
      ok: true,
      matched: report.matched,
      backfilled: report.backfilled,
      partial: report.partial,
    }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: userMessage(error.code, error.values) }
    }
    throw error
  }
}

/**
 * Render the result.
 *
 * @param result tool result @returns one line for the model
 */
export function renderBackfillResult(result: BackfillToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  const base = `回填完成：补记 ${String(result.backfilled)} / 已存在 ${String(result.matched)}`
  return result.partial ? `${base}（只导入了平台最近一页，更早的历史未导入）` : base
}
