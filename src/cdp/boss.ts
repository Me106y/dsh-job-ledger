/**
 * The single platform adapter (TECH §5, PRD §9).
 *
 * Every URL, response pattern, selector and business code that belongs to BOSS lives here and
 * carries a version. BOSS redesigns its pages; when that happens, only this file changes, and the
 * version string records which snapshot the selectors were captured from.
 *
 * @module dsh-job-ledger/cdp/boss
 */

import type { ErrorCode } from '../shared/errors.ts'

/**
 * Marker for the page snapshot these patterns were captured from.
 *
 * P1 has listed the endpoints from PRD §5.1/§5.2 but has **not** verified the response shapes
 * against a live account — see `docs/TECH-DESIGN.md §20`.
 */
export const BOSS_VERSION = '2026-11-03'

/** Pages the plugin navigates to. */
export const BOSS_URLS = {
  resume: 'https://www.zhipin.com/web/geek/resume',
  chat: 'https://www.zhipin.com/web/geek/chat',
  search: 'https://www.zhipin.com/web/geek/job',
} as const

/**
 * Response patterns for the requests the page makes itself.
 *
 * Matching is on the path plus the `.json` suffix; query parameters are ignored, because the
 * platform adds tracking parameters freely and a stricter pattern would silently stop matching.
 */
export const BOSS_API = {
  resumeBaseinfo: /\/wapi\/zpgeek\/resume\/baseinfo\/query\.json(?:\?|$)/,
  resumeExpect: /\/wapi\/zpgeek\/resume\/expect\/query\.json(?:\?|$)/,
  resumeStatus: /\/wapi\/zpgeek\/resume\/status\.json(?:\?|$)/,
} as const

/**
 * Business codes that must stop the run rather than fail one job (PRD §5.5, TECH §9.4).
 *
 * `31` (IP restricted) has no dedicated user-facing code in the table; rate limiting is the
 * closest actionable message, and either way the run halts.
 */
export const BOSS_BUSINESS_CODES: Readonly<Record<number, ErrorCode>> = {
  9: 'E_RATE_LIMITED',
  31: 'E_RATE_LIMITED',
  32: 'E_ACCOUNT_RISK',
  36: 'E_ACCOUNT_RISK',
  37: 'E_STOKEN_EXPIRED',
}

/** @param code business code from a response body @returns the user-facing code, if it is fatal */
export function bossErrorCode(code: number): ErrorCode | undefined {
  return BOSS_BUSINESS_CODES[code]
}
