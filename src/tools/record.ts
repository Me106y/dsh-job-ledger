/**
 * The `record` tool: a human records what happened after the application went out (PRD §5.6).
 *
 * The platform only ever tells us "沟通过"; replies, interviews and offers have to be entered by
 * hand. Without this tool the funnel has a numerator of zero forever, and "which channel is worth
 * investing in" can never be answered.
 *
 * It is a thin door onto the ledger's own state machine: the transition table decides what is
 * legal, so this tool cannot invent a state the machine does not allow.
 *
 * @module dsh-job-ledger/tools/record
 */

import type { AppState } from '../ledger/events.ts'
import type { Ledger } from '../ledger/store.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const RECORD_TOOL_NAME = 'job_ledger_record'

/** Model-facing description. */
export const RECORD_TOOL_DESCRIPTION =
  '记录一次投递之后的进展（回复 / 面试 / offer / 拒绝 / 撤回）。只允许状态机允许的转移，非法转移会被拒绝并返回允许的目标状态。'

/** States a person may record by hand. */
export const RECORDABLE_STATES: readonly AppState[] = [
  'replied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'failed',
]

/** What the tool returns. */
export type RecordToolResult =
  | { readonly ok: true; readonly appId: string; readonly state: AppState }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
      readonly allowed?: string
    }

/**
 * Input the model supplies.
 *
 * Queue rows carry job ids, not application ids, so either is accepted: with `jobId` the latest
 * application for that job is used. Requiring an id the model cannot see would make the tool
 * unusable from the screen that lists what to record.
 */
export interface RecordInput {
  readonly appId?: string | undefined
  readonly jobId?: string | undefined
  readonly state: AppState
  readonly note?: string | undefined
}

/**
 * Record a state change.
 *
 * @param ledger the single writer
 * @param input application, target state, optional note
 * @param now epoch ms
 * @returns the new state, or a coded refusal with the allowed targets
 */
export function recordForModel(
  ledger: Ledger,
  input: RecordInput,
  now: number = Date.now(),
): RecordToolResult {
  const appId = resolveAppId(ledger, input)
  if (typeof appId !== 'string') {
    return {
      ok: false,
      code: 'E_INVALID_ARGUMENT',
      message: userMessage('E_INVALID_ARGUMENT', { what: appId.what }),
    }
  }

  if (!RECORDABLE_STATES.includes(input.state) && input.state !== 'submitted') {
    return {
      ok: false,
      code: 'E_INVALID_ARGUMENT',
      message: userMessage('E_INVALID_ARGUMENT', {
        what: `state ${input.state} is not recordable by hand`,
      }),
    }
  }

  try {
    ledger.append({
      type: 'app/state',
      appId,
      state: input.state,
      ...(input.note === undefined ? {} : { note: input.note }),
      at: new Date(now).toISOString(),
    })
  } catch (error) {
    if (error instanceof PluginError) {
      return {
        ok: false,
        code: error.code,
        message: userMessage(error.code, error.values),
        ...(error.values?.['allowed'] === undefined ? {} : { allowed: error.values['allowed'] }),
      }
    }
    throw error
  }

  return { ok: true, appId, state: input.state }
}

/**
 * Resolve which application the caller means.
 *
 * @param ledger ledger @param input app id or job id @returns the app id, or a description of why not
 */
function resolveAppId(ledger: Ledger, input: RecordInput): string | { readonly what: string } {
  if (input.appId !== undefined) {
    return ledger.projection.apps.has(input.appId)
      ? input.appId
      : { what: `app ${input.appId} is not in the ledger` }
  }

  const jobId = input.jobId
  if (jobId === undefined) return { what: 'either appId or jobId is required' }

  const appIds = ledger.projection.appsByJob.get(jobId) ?? []
  const latest = appIds.at(-1)
  if (latest === undefined) return { what: `job ${jobId} has no application to record` }
  return latest
}

/**
 * Render the result.
 *
 * @param result tool result @returns one line for the model
 */
export function renderRecordResult(result: RecordToolResult): string {
  if (!result.ok) {
    const allowed = result.allowed === undefined ? '' : `（允许：${result.allowed}）`
    return `[${result.code}] ${result.message}${allowed}`
  }
  return `已记录：${result.appId} → ${result.state}`
}
