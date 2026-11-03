/**
 * The `apply` tool: the only model-side entry to a run (TECH §9.5, PRD §5.10).
 *
 * There is exactly one function that starts a run (`startRun`), and this tool calls it. The panel
 * will call the same one. `grantedBy` records which side asked, so "who authorized this" is
 * answerable after the fact.
 *
 * @module dsh-job-ledger/tools/apply
 */

import type { GrantedBy, RunSummary } from '../ledger/events.ts'
import type { RunRequest, RunResult } from '../run/executor.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const APPLY_TOOL_NAME = 'job_ledger_apply'

/** Model-facing description. Says what it will not do. */
export const APPLY_TOOL_DESCRIPTION =
  '对选中的岗位发起一轮投递（最多 10 个）。会真实点击、发送招呼语、保存证据。不会自动重试 uncertain，遇到风控/验证码会停止整轮。'

/** What a run returns to the model. */
export type ApplyToolResult =
  | {
      readonly ok: true
      readonly runId: string
      readonly outcome: RunResult['outcome']
      readonly summary: RunSummary
      readonly haltReason?: string
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The runner surface the tool needs; keeps this module free of the executor import. */
export interface RunStarter {
  run(request: RunRequest): Promise<RunResult>
}

/**
 * Start a run on behalf of the model.
 *
 * @param starter the single run entry
 * @param ids jobs to apply to
 * @param now epoch ms, for the authorization record
 * @returns the run result, or a coded refusal
 */
export async function applyForModel(
  starter: RunStarter,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<ApplyToolResult> {
  const grantedBy: GrantedBy = { kind: 'model', at: new Date(now).toISOString() }
  try {
    const result = await starter.run({ ids, grantedBy })
    return {
      ok: true,
      runId: result.runId,
      outcome: result.outcome,
      summary: result.summary,
      ...(result.haltReason === undefined ? {} : { haltReason: result.haltReason }),
    }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: userMessage(error.code, error.values) }
    }
    throw error
  }
}

/**
 * One line summarising the run.
 *
 * @param result tool result
 * @returns text for the model
 */
export function renderApplyResult(result: ApplyToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  const parts = [
    `投递成功 ${String(result.summary.submitted)}`,
    `不确定 ${String(result.summary.uncertain)}`,
    `失败 ${String(result.summary.failed)}`,
    `跳过 ${String(result.summary.skipped)}`,
  ]
  const halt = result.haltReason === undefined ? '' : ` · 已熔断：${result.haltReason}`
  return `本轮结束（${result.outcome}）：${parts.join(' / ')}${halt}`
}
