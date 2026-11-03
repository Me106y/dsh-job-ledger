/**
 * The `resume` tool's behaviour, kept free of the tool runtime.
 *
 * This module deliberately has **no runtime import** from `@deepseek-ai/dsh-tools` or cordis: the
 * tool registry pulls in a dozen peer packages that only the harness provides, and a unit test
 * should not need them. Registration lives in `tools/register.ts`, which is type-checked but not
 * imported by tests.
 *
 * Two conventions from this repo are load-bearing here:
 *
 * - **Failures are values, not exceptions.** A failed read returns `{ ok: false, code, message }`
 *   so one bad call cannot abort the model's turn (see `shared/errors.ts`).
 * - **The model never sees unredacted PII.** Redaction happens between the reader and the return
 *   value, not in the prompt.
 *
 * @module dsh-job-ledger/tools/resume
 */

import { summarizeResume } from '../resume/parse.ts'
import { readResume } from '../resume/read.ts'
import { redactResume } from '../resume/redact.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import type { ResumeExposure } from '../shared/profile.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. Prefixed so it cannot collide with another plugin's tool. */
export const RESUME_TOOL_NAME = 'job_ledger_resume'

/** Model-facing description. Says what it does *not* do, because the model will ask. */
export const RESUME_TOOL_DESCRIPTION =
  '读取当前 BOSS 账号的在线简历，返回脱敏摘要（期望职位 / 城市 / 薪资 / 年限 / 技能）。不修改简历，不投递。'

/** A lossless JSON value, structurally compatible with the output schema's `json` node. */
export type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { readonly [key: string]: JsonLike }

/** What the tool returns: a summary on success, a code and message on failure. */
export type ResumeToolResult =
  | { readonly ok: true; readonly summary: string; readonly resume: JsonLike }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * @param value structured data @returns the same data as lossless JSON (undefined members dropped)
 */
function asJson(value: unknown): JsonLike {
  return JSON.parse(JSON.stringify(value)) as JsonLike
}

/**
 * Read the resume for the model.
 *
 * @param runtime something that yields a browser reader
 * @param exposure configured privacy level
 * @returns the tool result
 */
export async function readResumeForModel(
  runtime: ReaderProvider,
  exposure: ResumeExposure,
  options: { readonly raw?: boolean } = {},
): Promise<ResumeToolResult> {
  // `raw` asks for the unredacted resume. It is a request, not an override: the configuration
  // decides. Refusing loudly beats silently returning redacted data and looking broken.
  if (options.raw === true && exposure !== 'full') {
    return {
      ok: false,
      code: 'E_PRIVACY_BLOCKED',
      message: userMessage('E_PRIVACY_BLOCKED'),
    }
  }
  try {
    const reader = await runtime.reader()
    const resume = await readResume(reader)
    const redacted = redactResume(resume, exposure)
    return { ok: true, summary: summarizeResume(redacted), resume: asJson(redacted) }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

/**
 * Turn a result into the one line the model reads.
 *
 * @param value tool result
 * @returns the rendered text
 */
export function renderResumeResult(value: ResumeToolResult): string {
  return value.ok ? value.summary : `[${value.code}] ${value.message}`
}
