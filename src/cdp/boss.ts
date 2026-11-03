/**
 * The single platform adapter (TECH §5, PRD §9).
 *
 * Every URL, response pattern, selector and business code that belongs to BOSS lives here and
 * carries a version. BOSS redesigns its pages; when that happens, only this file changes, and the
 * version string records which snapshot the selectors were captured from.
 *
 * @module dsh-job-ledger/cdp/boss
 */

import { PluginError } from '../shared/errors.ts'
import type { ErrorCode } from '../shared/errors.ts'
import { record } from '../shared/json.ts'

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
  /** Search results. */
  searchList: /\/wapi\/zpgeek\/search\/joblist\.json(?:\?|$)/,
  /** The recommendation rail the search page also loads. */
  recommendList: /\/wapi\/zpgeek\/pc\/recommend\/job\/list\.json(?:\?|$)/,
  /** The delivered-applications list used for reconciliation. */
  deliverList: /\/wapi\/zpgeek\/geek\/deliver\/list\.json(?:\?|$)/,
  /**
   * The request the page fires when an application is sent.
   *
   * ⚠️ Unverified: TECH §20 item 1 says to confirm whether this is `friend/add` and whether the
   * resume is a second request. When it does not match, the attempt degrades to `uncertain`.
   */
  sendResume: /\/wapi\/zpgeek\/(?:geek\/)?friend\/add\.json(?:\?|$)/,
} as const

/**
 * Selectors used while applying to one job.
 *
 * ⚠️ Every one of these is a guess until a live page is inspected (TECH §20 items 1-3, 7). They are
 * collected here, versioned by {@link BOSS_VERSION}, so a redesign changes one file.
 */
export const BOSS_SELECTORS = {
  /** 立即沟通 on the job detail page. */
  contactButton: '.btn-startchat, .op-btn-chat, a.btn-startchat',
  greetingInput: '.chat-input textarea, textarea.input-area, #chat-input',
  sendButton: '.chat-op .btn-send, .btn-send',
  /** Optional second step: some page versions send the resume from a toolbar button. */
  sendResumeButton: '.toolbar .btn-send-resume, .send-resume',
  chatPanel: '.chat-container, .chat-content, .dialog-container',
  resumeCard: '.message-card .card-resume, .resume-card, [class*="resume-card"]',
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

/**
 * Refuse a payload whose business code is not success.
 *
 * BOSS answers `200 OK` with a non-zero code for "rate limited", "login expired" and friends, so
 * the HTTP status says nothing. Mapping those to fatal codes here is what makes callers halt the
 * run instead of treating a rejection as an empty result.
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
 * Whether a URL means "you are not logged in".
 *
 * BOSS redirects an expired session to a user/login page instead of answering 401, so after a
 * navigation this is the only cheap check that separates "logged out" from "page still loading".
 *
 * @param url page URL
 * @returns whether the page is the login wall
 */
export function isLoginUrl(url: string): boolean {
  return /\/web\/user\/|\/login/i.test(url)
}
