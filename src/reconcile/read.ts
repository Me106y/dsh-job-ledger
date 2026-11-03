/**
 * Read the delivered-applications list from the chat page (PRD §5.7, TECH §10.1).
 *
 * Only the first page is read. The paging parameters are unverified (TECH §20 item 5), and a
 * reconciliation that silently checks the newest twenty applications while claiming to check all of
 * them would manufacture discrepancies. `partial` says so out loud.
 *
 * @module dsh-job-ledger/reconcile/read
 */

import { BOSS_API, BOSS_URLS, assertBossSuccess } from '../cdp/boss.ts'
import type { BrowserReader } from '../cdp/browser.ts'
import { assertLoggedIn } from '../cdp/login.ts'
import { parseDeliverList } from './parse.ts'
import type { DeliveredRow } from './parse.ts'

/** What one read produced. */
export interface DeliveredRead {
  readonly rows: readonly DeliveredRow[]
  readonly invalid: number
  /** Always true for now: page 1 only. */
  readonly partial: boolean
}

/**
 * Read the platform's view of recent applications.
 *
 * @param browser reader positioned anywhere in the session
 * @returns rows plus the invalid count
 */
export async function readDelivered(browser: BrowserReader): Promise<DeliveredRead> {
  const pending = browser.capture(BOSS_API.deliverList)

  // The chat page is where the list request originates (it needs that page as its referer).
  await browser.navigate(BOSS_URLS.chat)
  await assertLoggedIn(browser, [pending])

  const payload = await pending
  assertBossSuccess(payload)

  const parsed = parseDeliverList(payload)
  return { rows: parsed.rows, invalid: parsed.invalid, partial: true }
}
