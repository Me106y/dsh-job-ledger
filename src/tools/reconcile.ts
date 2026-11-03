/**
 * The `reconcile` tool: ask the platform what it thinks happened (PRD §5.7).
 *
 * Read-only from the ledger's perspective unless there is something to backfill: a platform-side
 * application the ledger never recorded is exactly the gap this product exists to close.
 *
 * @module dsh-job-ledger/tools/reconcile
 */

import type { Ledger } from '../ledger/store.ts'
import { reconcile } from '../reconcile/boss.ts'
import type { Discrepancy, PlatformOnlyRow, ReconcileReport } from '../reconcile/boss.ts'
import { readDelivered } from '../reconcile/read.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const RECONCILE_TOOL_NAME = 'job_ledger_reconcile'

/** Model-facing description. */
export const RECONCILE_TOOL_DESCRIPTION =
  '用平台的投递记录核对账本：平台有账本无则补记 submitted，账本有平台无则列为差异（不改状态）。只读接口，不投递。'

/** What reconciliation returns. */
export type ReconcileToolResult =
  | {
      readonly ok: true
      readonly matched: number
      readonly backfilled: number
      readonly partial: boolean
      readonly discrepancies: Discrepancy[]
      readonly platformOnly: PlatformOnlyRow[]
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Knobs the tool does not expose but tests pin. */
export interface ReconcileToolOptions {
  readonly now?: number | undefined
  readonly newId?: (() => string) | undefined
}

/**
 * Run one reconciliation pass.
 *
 * @param provider browser access
 * @param ledger the single writer
 * @param options clock and ids
 * @returns counts plus the discrepancy list, or a coded failure
 */
export async function reconcileForModel(
  provider: ReaderProvider,
  ledger: Ledger,
  options: ReconcileToolOptions = {},
): Promise<ReconcileToolResult> {
  try {
    const reader = await provider.reader()
    const delivered = await readDelivered(reader)
    const report: ReconcileReport = reconcile(ledger, delivered.rows, {
      partial: delivered.partial,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    })
    return {
      ok: true,
      matched: report.matched,
      backfilled: report.backfilled,
      partial: report.partial,
      discrepancies: [...report.discrepancies],
      platformOnly: [...report.platformOnly],
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
 * @param result tool result
 * @returns one line for the model
 */
export function renderReconcileResult(result: ReconcileToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  const base = `对账完成：匹配 ${String(result.matched)} / 补记 ${String(result.backfilled)} / 差异 ${String(result.discrepancies.length)}`
  return result.partial
    ? `${base}（只核对了平台最近一页，差异可能包含更早的投递）`
    : base
}
