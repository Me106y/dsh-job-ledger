/**
 * Error codes shared by the host plugin, the tools, and the web panel.
 *
 * One table, three consumers: the host decides what to do, the tool returns the code to the model,
 * and the panel renders the localized message. Keeping them in one place is what stops the three
 * from drifting into three different ideas of what went wrong.
 *
 * See docs/PRD.md §15 and docs/TECH-DESIGN.md §15.
 *
 * @module dsh-job-ledger/shared/errors
 */

/** Every failure the plugin can report, with the message a person sees. */
export const ERROR_MESSAGES = {
  E_LOGIN_REQUIRED: '需要登录 BOSS：请在弹出的浏览器里扫码',
  E_CAPTCHA: '遇到验证码，本轮已停止。请先在浏览器里人工处理',
  E_RATE_LIMITED: '触发平台频率限制，本轮已停止。建议 24 小时后再试',
  E_ACCOUNT_RISK: '账号存在异常风险，已停止全部自动化。请先到官网确认账号状态',
  E_STOKEN_EXPIRED: '登录态已过期，请重新扫码',
  E_SELECTOR_MISSING: '页面结构发生变化，找不到目标元素',
  E_BODY_UNAVAILABLE: '没能取到页面响应内容',
  E_NAV_TIMEOUT: '页面加载超时',
  E_SEND_UNCONFIRMED: '已点击，但无法确认简历是否送达',
  E_ALREADY_APPLIED: '该岗位已经投过',
  E_LEASE_HELD: '另一个运行正在投这个岗位',
  E_DAILY_QUOTA: '今日投递额度已用完',
  E_RUN_ACTIVE: '已有一轮投递正在运行',
  E_ILLEGAL_TRANSITION: '当前状态不允许这样变更',
  E_UNBALANCED: '账本与平台不一致，请先处理差异',
  E_CHROME_NOT_FOUND: '没有找到 Chrome，请安装或设置 chromePath',
  E_CHROME_NOT_STARTED: 'Chrome 启动失败',
  E_CDP_DISCONNECTED: '浏览器连接已断开',
  E_LEDGER_WRITE: '账本写入失败，请检查磁盘空间与权限',
  E_LEDGER_VERSION: '账本由更新版本的插件写入，请先升级插件',
  E_NOT_CONFIGURED: '插件还没有完成首次配置',
} as const

/** A failure code from {@link ERROR_MESSAGES}. */
export type ErrorCode = keyof typeof ERROR_MESSAGES

/** Structured failure as returned by tools and the host API. */
export interface LedgerFailure {
  readonly code: ErrorCode
  readonly values?: Readonly<Record<string, string>>
}

/** Codes that must stop the whole run, not just skip one job. */
const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'E_CAPTCHA',
  'E_RATE_LIMITED',
  'E_ACCOUNT_RISK',
  'E_STOKEN_EXPIRED',
  'E_CDP_DISCONNECTED',
  'E_CHROME_NOT_STARTED',
  'E_LEDGER_WRITE',
])

/** Codes where retrying the same job once is reasonable. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'E_BODY_UNAVAILABLE',
  'E_NAV_TIMEOUT',
])

/** @param value candidate @returns whether it is a known code */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value)
}

/** @param code failure code @returns whether the whole run must halt */
export function isFatal(code: ErrorCode): boolean {
  return FATAL.has(code)
}

/** @param code failure code @returns whether one retry of the same job is allowed */
export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code)
}

/**
 * Fill `{name}` placeholders from `values`. Unknown placeholders are left verbatim so a missing
 * value is visible in the UI instead of silently rendering an empty string.
 *
 * @param template message with optional placeholders
 * @param values substitution values
 * @returns the rendered message
 */
export function fillTemplate(template: string, values?: Readonly<Record<string, string>>): string {
  if (values === undefined) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => values[name] ?? match)
}

/**
 * Build the user-facing message for a failure.
 *
 * @param code failure code
 * @param values placeholder values
 * @returns localized message
 */
export function userMessage(code: ErrorCode, values?: Readonly<Record<string, string>>): string {
  return fillTemplate(ERROR_MESSAGES[code], values)
}

/**
 * Create a structured failure. Tools return this instead of throwing, so a single failed job never
 * aborts the model's turn.
 *
 * @param code failure code
 * @param values placeholder values
 * @returns the failure record
 */
export function failure(code: ErrorCode, values?: Readonly<Record<string, string>>): LedgerFailure {
  return values === undefined ? { code } : { code, values }
}

/**
 * A coded failure thrown by a layer that has no return channel (state machine, ledger writer).
 *
 * Tools never throw this: they catch it and return `failure()`. The class exists so a thrown error
 * still carries a code the host can branch on, instead of an anonymous `Error` whose message has to
 * be pattern-matched at the call site.
 */
export class PluginError extends Error {
  readonly code: ErrorCode
  readonly values?: Readonly<Record<string, string>>

  /**
   * @param code failure code
   * @param values placeholder values for the user-facing message
   */
  constructor(code: ErrorCode, values?: Readonly<Record<string, string>>) {
    super(userMessage(code, values))
    this.name = 'PluginError'
    this.code = code
    if (values !== undefined) this.values = values
  }

  /** @returns the structured failure shape tools and the host API return */
  toFailure(): LedgerFailure {
    return failure(this.code, this.values)
  }
}
