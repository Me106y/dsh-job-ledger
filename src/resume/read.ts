/**
 * Read the online resume (PRD §5.1, TECH §5.3).
 *
 * The order matters and is the whole trick: arm the three captures **before** navigating, because
 * the page fires its own requests as it loads and a capture armed afterwards waits for a response
 * that already went by. Nothing in this path constructs a request.
 *
 * @module dsh-job-ledger/resume/read
 */

import { BOSS_API, BOSS_URLS, bossErrorCode } from '../cdp/boss.ts'
import type { BrowserReader } from '../cdp/browser.ts'
import { PluginError } from '../shared/errors.ts'
import { parseResume } from './parse.ts'
import type { Resume } from './parse.ts'

/** @param value candidate @returns it as a plain object, when it is one */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Refuse a payload whose business code is not success.
 *
 * BOSS answers `200 OK` with a non-zero code for "rate limited", "login expired" and friends, so
 * the HTTP status says nothing. Mapping those to fatal codes here is what makes the caller halt the
 * run instead of treating a rejection as an empty resume.
 *
 * @param payload response body
 * @throws PluginError with the mapped fatal code, or `E_BODY_UNAVAILABLE` for an unknown code
 */
export function assertBossSuccess(payload: unknown): void {
  const code = record(payload)?.code
  if (typeof code !== 'number' || code === 0) return
  const mapped = bossErrorCode(code)
  if (mapped !== undefined) throw new PluginError(mapped, { code: String(code) })
  throw new PluginError('E_BODY_UNAVAILABLE', { what: `unexpected business code ${String(code)}` })
}

/**
 * Read and parse the online resume.
 *
 * @param browser reader connected to a page the user is logged into
 * @returns the structured resume (unredacted; callers pass it through `redactResume`)
 */
export async function readResume(browser: BrowserReader): Promise<Resume> {
  const baseinfo = browser.capture(BOSS_API.resumeBaseinfo)
  const expect = browser.capture(BOSS_API.resumeExpect)
  const status = browser.capture(BOSS_API.resumeStatus)

  await browser.navigate(BOSS_URLS.resume)

  const [baseBody, expectBody, statusBody] = await Promise.all([baseinfo, expect, status])
  for (const body of [baseBody, expectBody, statusBody]) assertBossSuccess(body)

  return parseResume({ baseinfo: baseBody, expect: expectBody, status: statusBody })
}
