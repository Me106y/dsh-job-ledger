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
  /** Where a logged-out session lands; opening it directly shows the QR code. */
  login: 'https://www.zhipin.com/web/user/',
} as const

/**
 * City name → the `city` code the search page uses in its URL.
 *
 * Verified for 北京 (101010100) against the live search page on 2026-11-04; the rest follow the same
 * 101xxxxxx scheme and are marked unverified in TECH §20. An unknown city is not guessed: the search
 * then keeps the site's own selection, exactly as before.
 */
export const CITY_CODES: Readonly<Record<string, string>> = {
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  南京: '101190100',
  武汉: '101200100',
  西安: '101110100',
  苏州: '101190400',
  长沙: '101250100',
  重庆: '101040100',
  天津: '101030100',
  郑州: '101180100',
  青岛: '101120200',
  合肥: '101220100',
  厦门: '101230200',
  福州: '101230100',
  济南: '101120100',
  大连: '101070200',
  无锡: '101190200',
  东莞: '101281600',
  佛山: '101280800',
  宁波: '101210400',
  珠海: '101280700',
  昆明: '101290100',
  南昌: '101240100',
  贵阳: '101260100',
  南宁: '101300100',
  石家庄: '101090100',
  太原: '101100100',
  沈阳: '101070100',
  长春: '101060100',
  哈尔滨: '101050100',
  兰州: '101160100',
  乌鲁木齐: '101130100',
  海口: '101310100',
}

/**
 * @param city city name as the user wrote it @returns its search code, when known
 */
export function cityCode(city: string): string | undefined {
  return CITY_CODES[city.trim()]
}

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
  /**
   * 登录页左上角的「APP扫码登录」开关。
   *
   * Verified against the real login page on 2026-11-03: the page defaults to SMS, and this element is
   * `<div class="switch-tip">APP扫码登录</div>` inside `.btn-sign-switch.ewm-switch`.
   */
  loginQrSwitch: '.btn-sign-switch',
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

/**
 * Whether a URL is a page on the platform at all.
 *
 * A freshly launched browser sits on `about:blank`; "not the login page" there is not evidence of a
 * session, so callers have to distinguish "a BOSS page that is not the login wall" from "no page".
 *
 * @param url page URL
 * @returns whether the URL belongs to zhipin.com
 */
export function isBossUrl(url: string): boolean {
  return /^https:\/\/(?:[^/]+\.)?zhipin\.com\//i.test(url)
}
