/**
 * Registration glue for the tools.
 *
 * Separated from `tools/resume.ts` so the behaviour can be tested without the harness: importing
 * `@deepseek-ai/dsh-tools` at runtime needs the whole peer tree, which only a DSH install has.
 *
 * @module dsh-job-ledger/tools/register
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { LedgerConfig } from '../config.ts'
import type { Ledger } from '../ledger/store.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import type { ProfileSource } from '../settings.ts'
import {
  RESUME_TOOL_DESCRIPTION,
  RESUME_TOOL_NAME,
  readResumeForModel,
  renderResumeResult,
} from './resume.ts'
import type { ResumeToolResult } from './resume.ts'
import {
  DISCOVER_TOOL_DESCRIPTION,
  DISCOVER_TOOL_NAME,
  discoverForModel,
  renderDiscoverResult,
} from './discover.ts'
import type { DiscoverToolResult } from './discover.ts'
import { QUEUE_TOOL_DESCRIPTION, QUEUE_TOOL_NAME, queueForModel, renderQueueResult } from './queue.ts'
import type { QueueToolResult } from './queue.ts'
import { APPLY_TOOL_DESCRIPTION, APPLY_TOOL_NAME, applyForModel, renderApplyResult } from './apply.ts'
import type { ApplyToolResult, RunStarter } from './apply.ts'
import { REPORT_TOOL_DESCRIPTION, REPORT_TOOL_NAME, renderReportResult, reportForModel } from './report.ts'
import type { ReportToolResult } from './report.ts'
import { PROFILE_TOOL_DESCRIPTION, PROFILE_TOOL_NAME, profileView } from './profile.ts'
import { RECORD_TOOL_DESCRIPTION, RECORD_TOOL_NAME, recordForModel, renderRecordResult } from './record.ts'
import { LOGIN_TOOL_DESCRIPTION, LOGIN_TOOL_NAME, loginForModel, renderLoginResult } from './login.ts'
import type { LoginToolResult } from './login.ts'
import type { RecordToolResult } from './record.ts'
import { BACKFILL_TOOL_DESCRIPTION, BACKFILL_TOOL_NAME, backfillForModel, renderBackfillResult } from './backfill.ts'
import type { BackfillToolResult } from './backfill.ts'
import {
  RECONCILE_TOOL_DESCRIPTION,
  RECONCILE_TOOL_NAME,
  reconcileForModel,
  renderReconcileResult,
} from './reconcile.ts'
import type { ReconcileToolResult } from './reconcile.ts'

/**
 * Build the tool definition.
 *
 * @param runtime reader provider
 * @param config resolved configuration
 * @returns the definition to register
 */
export function resumeTool(runtime: ReaderProvider, config: LedgerConfig) {
  return defineTool({
    name: RESUME_TOOL_NAME,
    description: RESUME_TOOL_DESCRIPTION,
    parameters: {
      raw: {
        type: 'boolean',
        description: '返回未脱敏的简历原文；仅当 privacy.resumeExposure 为 full 时可用',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              summary: { type: 'string', required: true },
              resume: { type: 'json', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderResumeResult(value as ResumeToolResult) }]
      },
    },
    timeoutMs: 60_000,
    async execute(args) {
      return readResumeForModel(runtime, config.profile.privacy.resumeExposure, {
        raw: args.raw === true,
      })
    },
  })
}

/**
 * Register the tool on a cordis context.
 *
 * @param ctx host context (needs the `tools` service)
 * @param runtime reader provider
 * @param config resolved configuration
 * @returns the disposer that unregisters the tool
 */
export function registerResumeTool(
  ctx: Context,
  runtime: ReaderProvider,
  config: LedgerConfig,
): () => void {
  return ctx.tools.register(resumeTool(runtime, config))
}

/**
 * Build the discovery tool definition.
 *
 * @param ledger the single writer
 * @param runtime reader provider
 * @param config resolved configuration
 * @param source the live profile (the panel can change the target after mount)
 * @returns the definition to register
 */
export function discoverTool(
  ledger: Ledger,
  runtime: ReaderProvider,
  config: LedgerConfig,
  source: ProfileSource,
) {
  return defineTool({
    name: DISCOVER_TOOL_NAME,
    description: DISCOVER_TOOL_DESCRIPTION,
    parameters: {
      source: {
        type: 'string',
        enum: ['search', 'recommend'],
        description: '抓推荐流还是搜索结果，默认 search',
      },
      limit: {
        type: 'number',
        description: '本页最多处理多少条，默认 50（上限也是 50）',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              source: { type: 'string', required: true },
              added: { type: 'number', required: true },
              duplicates: { type: 'number', required: true },
              filtered: { type: 'number', required: true },
              suspects: { type: 'number', required: true },
              invalid: { type: 'number', required: true },
              decisions: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    jobId: { type: 'string' },
                    externalId: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                    duplicateOf: { type: 'string' },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderDiscoverResult(value as DiscoverToolResult) }]
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      return discoverForModel(runtime, ledger, source.profile, {
        source: args.source === 'recommend' ? 'recommend' : 'search',
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
    },
  })
}

/**
 * Register the discovery tool on a cordis context.
 *
 * @param ctx host context (needs the `tools` service)
 * @param ledger the single writer
 * @param runtime reader provider
 * @param config resolved configuration
 * @returns the disposer that unregisters the tool
 */
export function registerDiscoverTool(
  ctx: Context,
  ledger: Ledger,
  runtime: ReaderProvider,
  config: LedgerConfig,
  source: ProfileSource,
): () => void {
  return ctx.tools.register(discoverTool(ledger, runtime, config, source))
}

/**
 * Build the queue tool definition. Read-only: it takes the ledger and never the browser.
 *
 * @param ledger the open ledger
 * @returns the definition to register
 */
export function queueTool(ledger: Ledger) {
  return defineTool({
    name: QUEUE_TOOL_NAME,
    description: QUEUE_TOOL_DESCRIPTION,
    parameters: {
      filter: {
        type: 'string',
        enum: ['new', 'suspect', 'filtered'],
        description: 'new=新岗位，suspect=疑似重复待裁决，filtered=被筛掉可捞回，默认 new',
      },
      limit: {
        type: 'number',
        description: '最多返回多少行，默认 50（上限也是 50）',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              filter: { type: 'string', required: true },
              total: { type: 'number', required: true },
              rows: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    jobId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    company: { type: 'string', required: true },
                    city: { type: 'string', required: true },
                    decision: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                    salaryRaw: { type: 'string' },
                    salaryMin: { type: 'number' },
                    duplicateOf: { type: 'string' },
                    source: { type: 'string', required: true },
                    firstSeenAt: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderQueueResult(value as QueueToolResult) }]
      },
    },
    async execute(args) {
      return queueForModel(ledger, {
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
    },
  })
}

/**
 * Register the queue tool on a cordis context.
 *
 * @param ctx host context (needs the `tools` service)
 * @param ledger the open ledger
 * @returns the disposer that unregisters the tool
 */
export function registerQueueTool(ctx: Context, ledger: Ledger): () => void {
  return ctx.tools.register(queueTool(ledger))
}

/**
 * Build the apply tool definition.
 *
 * The model-facing surface is deliberately small: ids in, counts out. Everything else — claiming,
 * clicking, evidence, halting — happens inside the one run entry.
 *
 * @param starter the single run entry
 * @returns the definition to register
 */
export function applyTool(starter: RunStarter) {
  return defineTool({
    name: APPLY_TOOL_NAME,
    description: APPLY_TOOL_DESCRIPTION,
    parameters: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要投递的岗位 id，1–10 个；必须已存在于待投清单里',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              runId: { type: 'string', required: true },
              outcome: { type: 'string', required: true },
              summary: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  submitted: { type: 'number', required: true },
                  uncertain: { type: 'number', required: true },
                  failed: { type: 'number', required: true },
                  skipped: { type: 'number', required: true },
                },
              },
              haltReason: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderApplyResult(value as ApplyToolResult) }]
      },
    },
    timeoutMs: 600_000,
    async execute(args) {
      return applyForModel(starter, args.ids)
    },
  })
}

/**
 * Register the apply tool on a cordis context.
 *
 * @param ctx host context (needs the `tools` service)
 * @param starter the single run entry
 * @returns the disposer that unregisters the tool
 */
export function registerApplyTool(ctx: Context, starter: RunStarter): () => void {
  return ctx.tools.register(applyTool(starter))
}

/**
 * Build the reconcile tool definition.
 *
 * @param ledger the single writer
 * @param runtime reader provider
 * @returns the definition to register
 */
export function reconcileTool(ledger: Ledger, runtime: ReaderProvider) {
  return defineTool({
    name: RECONCILE_TOOL_NAME,
    description: RECONCILE_TOOL_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              matched: { type: 'number', required: true },
              backfilled: { type: 'number', required: true },
              partial: { type: 'boolean', required: true },
              platformOnly: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    externalId: { type: 'string', required: true },
                    company: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                  },
                },
              },
              discrepancies: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    jobId: { type: 'string', required: true },
                    company: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    city: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderReconcileResult(value as ReconcileToolResult) }]
      },
    },
    timeoutMs: 60_000,
    async execute() {
      return reconcileForModel(runtime, ledger)
    },
  })
}

/**
 * Register the reconcile tool on a cordis context.
 *
 * @param ctx host context (needs the `tools` service)
 * @param ledger the single writer
 * @param runtime reader provider
 * @returns the disposer that unregisters the tool
 */
export function registerReconcileTool(
  ctx: Context,
  ledger: Ledger,
  runtime: ReaderProvider,
): () => void {
  return ctx.tools.register(reconcileTool(ledger, runtime))
}

/**
 * Build the report tool definition.
 *
 * @param ledger the open ledger
 * @param dataDir where a snapshot may be saved
 * @returns the definition to register
 */
export function reportTool(ledger: Ledger, dataDir: string) {
  return defineTool({
    name: REPORT_TOOL_NAME,
    description: REPORT_TOOL_DESCRIPTION,
    parameters: {
      save: {
        type: 'boolean',
        description: '同时把 Markdown 写到数据目录的 snapshot.md',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              markdown: { type: 'string', required: true },
              savedTo: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderReportResult(value as ReportToolResult) }]
      },
    },
    async execute(args) {
      return reportForModel(ledger, { save: args.save === true, dataDir })
    },
  })
}

/**
 * Register the report tool.
 *
 * @param ctx host context @param ledger open ledger @param dataDir data directory
 * @returns the disposer
 */
export function registerReportTool(ctx: Context, ledger: Ledger, dataDir: string): () => void {
  return ctx.tools.register(reportTool(ledger, dataDir))
}

/**
 * Build the profile tool definition. Read-only; the panel is the only writer.
 *
 * @param config resolved configuration
 * @param source the live profile, so panel edits show up without a restart
 * @returns the definition to register
 */
export function profileTool(config: LedgerConfig, source: ProfileSource) {
  return defineTool({
    name: PROFILE_TOOL_NAME,
    description: PROFILE_TOOL_DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const view = value as unknown as ReturnType<typeof profileView>
        const roles = view.target.roles.length === 0 ? '取自简历' : view.target.roles.join('、')
        return [
          {
            type: 'text',
            text: `目标：${roles} · 城市 ${view.target.cities.join('、') || '不限'} · 薪资 ≥ ${String(view.target.salaryMin)} 元/月 · 单轮 ${String(view.limits.runSize)} / 每日 ${String(view.limits.daily)}`,
          },
        ]
      },
    },
    async execute() {
      // Round-trip so the value is lossless JSON, which is what the `json` output node enforces.
      return JSON.parse(JSON.stringify(profileView({ ...config, profile: source.profile }))) as never
    },
  })
}

/**
 * Register the profile tool.
 *
 * @param ctx host context @param config resolved configuration
 * @returns the disposer
 */
export function registerProfileTool(
  ctx: Context,
  config: LedgerConfig,
  source: ProfileSource,
): () => void {
  return ctx.tools.register(profileTool(config, source))
}

/**
 * Build the backfill tool definition.
 *
 * @param ledger the single writer
 * @param runtime reader provider
 * @returns the definition to register
 */
export function backfillTool(ledger: Ledger, runtime: ReaderProvider) {
  return defineTool({
    name: BACKFILL_TOOL_NAME,
    description: BACKFILL_TOOL_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              matched: { type: 'number', required: true },
              backfilled: { type: 'number', required: true },
              partial: { type: 'boolean', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderBackfillResult(value as BackfillToolResult) }]
      },
    },
    timeoutMs: 60_000,
    async execute() {
      return backfillForModel(runtime, ledger)
    },
  })
}

/**
 * Register the backfill tool.
 *
 * @param ctx host context @param ledger the single writer @param runtime reader provider
 * @returns the disposer
 */
export function registerBackfillTool(
  ctx: Context,
  ledger: Ledger,
  runtime: ReaderProvider,
): () => void {
  return ctx.tools.register(backfillTool(ledger, runtime))
}

/**
 * Build the record tool definition.
 *
 * @param ledger the single writer
 * @returns the definition to register
 */
export function recordTool(ledger: Ledger) {
  return defineTool({
    name: RECORD_TOOL_NAME,
    description: RECORD_TOOL_DESCRIPTION,
    parameters: {
      appId: { type: 'string', description: '申请 id（与 jobId 二选一）' },
      jobId: { type: 'string', description: '岗位 id：取该岗位最近一次申请（与 appId 二选一）' },
      state: {
        type: 'string',
        enum: ['replied', 'interview', 'offer', 'rejected', 'withdrawn', 'failed', 'submitted'],
        required: true,
        description: '目标状态；非法转移会被拒绝并返回允许列表',
      },
      note: { type: 'string', description: '一句话备注，例如「HR 回复约面」' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              appId: { type: 'string', required: true },
              state: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              allowed: { type: 'string' },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderRecordResult(value as RecordToolResult) }]
      },
    },
    async execute(args) {
      return recordForModel(ledger, {
        ...(args.appId === undefined ? {} : { appId: args.appId }),
        ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
        state: args.state,
        ...(args.note === undefined ? {} : { note: args.note }),
      })
    },
  })
}

/**
 * Register the record tool.
 *
 * @param ctx host context @param ledger the single writer
 * @returns the disposer
 */
export function registerRecordTool(ctx: Context, ledger: Ledger): () => void {
  return ctx.tools.register(recordTool(ledger))
}

/**
 * Build the login tool definition.
 *
 * @param runtime reader provider
 * @returns the definition to register
 */
export function loginTool(runtime: ReaderProvider) {
  return defineTool({
    name: LOGIN_TOOL_NAME,
    description: LOGIN_TOOL_DESCRIPTION,
    parameters: {
      timeoutSeconds: {
        type: 'number',
        description: '最多等多少秒（默认 180，范围 30–300）',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              alreadyLoggedIn: { type: 'boolean', required: true },
              url: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderLoginResult(value as LoginToolResult) }]
      },
    },
    // The wait happens inside the tool, so its budget must exceed the default wait.
    timeoutMs: 320_000,
    async execute(args) {
      const seconds = Math.min(300, Math.max(30, args.timeoutSeconds ?? 180))
      return loginForModel(runtime, { timeoutMs: seconds * 1_000 })
    },
  })
}

/**
 * Register the login tool.
 *
 * @param ctx host context @param runtime reader provider
 * @returns the disposer
 */
export function registerLoginTool(ctx: Context, runtime: ReaderProvider): () => void {
  return ctx.tools.register(loginTool(runtime))
}
