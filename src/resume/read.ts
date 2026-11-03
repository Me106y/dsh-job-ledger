/**
 * Read the online resume (PRD §5.1, TECH §5.3).
 *
 * The order matters and is the whole trick: arm the three captures **before** navigating, because
 * the page fires its own requests as it loads and a capture armed afterwards waits for a response
 * that already went by. Nothing in this path constructs a request.
 *
 * @module dsh-job-ledger/resume/read
 */

import { BOSS_API, BOSS_URLS, assertBossSuccess } from '../cdp/boss.ts'
import { assertLoggedIn } from '../cdp/login.ts'
import type { BrowserReader } from '../cdp/browser.ts'
import { parseResume } from './parse.ts'
import type { Resume } from './parse.ts'

/**
 * Read and parse the online resume.
 *
 * @param browser reader connected to a page the user is logged into
 * @returns the structured resume (unredacted; callers pass it through `redactResume`)
 */
export async function readResume(browser: BrowserReader): Promise<Resume> {
  const captures = [
    browser.capture(BOSS_API.resumeBaseinfo),
    browser.capture(BOSS_API.resumeExpect),
    browser.capture(BOSS_API.resumeStatus),
  ]

  await browser.navigate(BOSS_URLS.resume)

  // An expired session is redirected to the login wall, where the three endpoints never fire.
  // Detecting it here turns a 20-second timeout into an actionable "scan the code" message.
  await assertLoggedIn(browser, captures)

  const [baseBody, expectBody, statusBody] = await Promise.all(captures)
  for (const body of [baseBody, expectBody, statusBody]) assertBossSuccess(body)

  return parseResume({ baseinfo: baseBody, expect: expectBody, status: statusBody })
}
