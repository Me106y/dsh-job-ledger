/**
 * Read one page of discovered postings (PRD §5.2).
 *
 * Same discipline as the resume read: arm the capture, navigate, check the login wall, then parse
 * what the page itself requested. Pagination is deliberately absent — the paging parameters are
 * still unverified (TECH §20 item 4), and silently fetching one page while claiming more would be
 * worse than saying "one page".
 *
 * @module dsh-job-ledger/discover/read
 */

import { BOSS_API, BOSS_URLS, assertBossSuccess } from '../cdp/boss.ts'
import type { BrowserReader } from '../cdp/browser.ts'
import { assertLoggedIn } from '../cdp/login.ts'
import { parseJobList } from './parse.ts'
import type { RawJob } from './parse.ts'

/** Where a batch of candidates came from. */
export type DiscoverySource = 'search' | 'recommend'

/** Hard cap per discovery (PRD §5.2). */
export const DISCOVERY_LIMIT = 50

/** One discovery pass. */
export interface DiscoveryResult {
  readonly source: DiscoverySource
  readonly jobs: readonly RawJob[]
  /** Cards that could not be identified. Counted so the summary is honest. */
  readonly invalid: number
}

/**
 * Build the page URL for a source.
 *
 * Search needs a query; without a configured role the page's own default is used rather than
 * inventing a query the user never asked for.
 *
 * @param source search or recommendation
 * @param roles configured roles, first one used as the query
 * @returns an absolute URL on the same origin
 */
export function discoveryUrl(
  source: DiscoverySource,
  roles: readonly string[] = [],
): string {
  if (source === 'recommend') return BOSS_URLS.search
  const role = roles[0]
  if (role === undefined) return BOSS_URLS.search
  const url = new URL(BOSS_URLS.search)
  url.searchParams.set('query', role)
  return url.toString()
}

/**
 * Read one page of postings.
 *
 * @param browser reader
 * @param source which list to read
 * @param roles configured roles, used to build the search query
 * @returns parsed jobs plus the invalid count
 */
export async function readJobList(
  browser: BrowserReader,
  source: DiscoverySource,
  roles: readonly string[] = [],
): Promise<DiscoveryResult> {
  const pattern = source === 'search' ? BOSS_API.searchList : BOSS_API.recommendList
  const pending = browser.capture(pattern)

  await browser.navigate(discoveryUrl(source, roles))
  await assertLoggedIn(browser, [pending])

  const payload = await pending
  assertBossSuccess(payload)

  const parsed = parseJobList(payload, DISCOVERY_LIMIT)
  return { source, jobs: parsed.jobs, invalid: parsed.invalid }
}
