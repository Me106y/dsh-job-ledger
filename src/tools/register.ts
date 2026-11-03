/**
 * Registration glue for the resume tool.
 *
 * Separated from `tools/resume.ts` so the behaviour can be tested without the harness: importing
 * `@deepseek-ai/dsh-tools` at runtime needs the whole peer tree, which only a DSH install has.
 *
 * @module dsh-job-ledger/tools/register
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { LedgerConfig } from '../config.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import {
  RESUME_TOOL_DESCRIPTION,
  RESUME_TOOL_NAME,
  readResumeForModel,
  renderResumeResult,
} from './resume.ts'
import type { ResumeToolResult } from './resume.ts'

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
