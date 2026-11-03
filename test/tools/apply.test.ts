import assert from 'node:assert/strict'
import test from 'node:test'

import { APPLY_TOOL_NAME, applyForModel, renderApplyResult } from '../../src/tools/apply.ts'
import type { RunStarter } from '../../src/tools/apply.ts'
import { PluginError } from '../../src/shared/errors.ts'
import type { RunRequest, RunResult } from '../../src/run/executor.ts'

const NOW = Date.parse('2026-11-03T00:00:00.000Z')

/** @param result what the run returns @returns a starter that records the request */
function starter(result: RunResult): { starter: RunStarter; seen: RunRequest[] } {
  const seen: RunRequest[] = []
  return {
    seen,
    starter: {
      async run(request: RunRequest): Promise<RunResult> {
        seen.push(request)
        return result
      },
    },
  }
}

const DONE: RunResult = {
  runId: 'r_1',
  outcome: 'done',
  summary: { submitted: 2, uncertain: 0, failed: 0, skipped: 1 },
}

test('a run result is returned with its counts', async () => {
  const { starter: runStarter } = starter(DONE)
  const result = await applyForModel(runStarter, ['j_1', 'j_2'], NOW)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.runId, 'r_1')
  assert.equal(result.outcome, 'done')
  assert.deepEqual(result.summary, DONE.summary)
})

test('the authorization records that the model asked', async () => {
  const { starter: runStarter, seen } = starter(DONE)
  await applyForModel(runStarter, ['j_1'], NOW)

  assert.deepEqual(seen[0]?.grantedBy, { kind: 'model', at: new Date(NOW).toISOString() })
})

test('a refusal becomes a coded failure instead of a throw', async () => {
  const refusing: RunStarter = {
    async run() {
      throw new PluginError('E_RUN_ACTIVE')
    },
  }
  const result = await applyForModel(refusing, ['j_1'], NOW)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'E_RUN_ACTIVE')
  assert.ok(result.message.length > 0)
})

test('the halt reason is carried through when the run stopped early', async () => {
  const halted: RunResult = {
    runId: 'r_2',
    outcome: 'halted',
    haltReason: 'uncertain',
    summary: { submitted: 1, uncertain: 1, failed: 0, skipped: 0 },
  }
  const result = await applyForModel(starter(halted).starter, ['j_1'], NOW)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.haltReason, 'uncertain')
})

test('the rendered line states the counts and the halt reason', () => {
  assert.equal(
    renderApplyResult({
      ok: true,
      runId: 'r_1',
      outcome: 'halted',
      haltReason: 'uncertain',
      summary: { submitted: 1, uncertain: 1, failed: 0, skipped: 0 },
    }),
    '本轮结束（halted）：投递成功 1 / 不确定 1 / 失败 0 / 跳过 0 · 已熔断：uncertain',
  )
  assert.equal(
    renderApplyResult({ ok: false, code: 'E_DAILY_QUOTA', message: '今日投递额度已用完' }),
    '[E_DAILY_QUOTA] 今日投递额度已用完',
  )
})

test('the tool name is namespaced', () => {
  assert.equal(APPLY_TOOL_NAME, 'job_ledger_apply')
})
