/**
 * The `discover` tool's behaviour, kept free of the tool runtime (same split as the resume tool).
 *
 * One call does the whole PRD §5.2 contract: read one page, judge every card, write the events, and
 * report the counts. Splitting "read" from "judge" across two calls would create the intermediate
 * state the design explicitly avoids.
 *
 * @module dsh-job-ledger/tools/discover
 */

import type { DiscoverySource } from '../discover/read.ts'
import { DISCOVERY_LIMIT, readJobList } from '../discover/read.ts'
import { ingestJobs } from '../discover/ingest.ts'
import type { Ledger } from '../ledger/store.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import { PluginError } from '../shared/errors.ts'
import type { Profile } from '../shared/profile.ts'

/** Tool name as the model sees it. */
export const DISCOVER_TOOL_NAME = 'job_ledger_discover'

/** Model-facing description. */
export const DISCOVER_TOOL_DESCRIPTION =
  '抓取一页 BOSS 岗位（推荐或搜索），逐个判重后写入账本，返回 新增/重复/过滤/疑似 计数。只读页面自己发出的请求，不投递。'

/** One verdict as the model sees it. */
export interface DiscoveredJob {
  /** Present when the posting entered the ledger; a duplicate is not recorded. */
  readonly jobId?: string
  readonly externalId: string
  readonly kind: string
  readonly reason: string
  readonly duplicateOf?: string
}

/** What discovery returns: counts plus the verdicts, or a coded failure. */
export type DiscoverToolResult =
  | {
      readonly ok: true
      readonly source: DiscoverySource
      readonly added: number
      readonly duplicates: number
      readonly filtered: number
      readonly suspects: number
      readonly invalid: number
      readonly decisions: DiscoveredJob[]
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Optional knobs; the tool passes only limit and source. */
export interface DiscoverOptions {
  readonly source?: DiscoverySource | undefined
  readonly limit?: number | undefined
  readonly now?: number | undefined
  readonly newId?: (() => string) | undefined
}

/**
 * Discover, judge, and record one page.
 *
 * @param provider reader provider
 * @param ledger the single writer
 * @param profile user rules (roles build the search query)
 * @param options source, page cap, clock
 * @returns the counts and verdicts, or a coded failure
 */
export async function discoverForModel(
  provider: ReaderProvider,
  ledger: Ledger,
  profile: Profile,
  options: DiscoverOptions = {},
): Promise<DiscoverToolResult> {
  const source: DiscoverySource = options.source === 'recommend' ? 'recommend' : 'search'
  const limit = Math.min(Math.max(options.limit ?? DISCOVERY_LIMIT, 1), DISCOVERY_LIMIT)

  try {
    const reader = await provider.reader()
    const discovered = await readJobList(reader, source, profile.target.roles)
    const raw = discovered.jobs.slice(0, limit)

    const result = ingestJobs(ledger, raw, {
      source,
      invalid: discovered.invalid,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    })

    return {
      ok: true,
      source,
      added: result.added,
      duplicates: result.duplicates,
      filtered: result.filtered,
      suspects: result.suspects,
      invalid: result.invalid,
      decisions: [...result.decisions],
    }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

/**
 * One line summarising a discovery pass.
 *
 * @param result tool result
 * @returns the text the model reads
 */
export function renderDiscoverResult(result: DiscoverToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  return [
    `新增 ${String(result.added)}`,
    `判重 ${String(result.duplicates)}`,
    `过滤 ${String(result.filtered)}`,
    `疑似 ${String(result.suspects)}`,
    `无法识别 ${String(result.invalid)}`,
  ].join(' / ')
}
