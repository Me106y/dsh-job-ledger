/**
 * The `login` tool: let the person log in, then carry on (PRD §5.1).
 *
 * The plugin cannot log in for anyone, and it must not pretend a missing session is an empty result.
 * So when the session is gone, a tool opens the login page in the *same* Chrome profile it will use
 * later, waits for the person to scan, and reports honestly whether it worked. The profile keeps the
 * cookies, so this is a first-use and expired-session event, not a per-run one.
 *
 * @module dsh-job-ledger/tools/login
 */

import { BOSS_SELECTORS, BOSS_URLS, isBossUrl, isLoginUrl } from '../cdp/boss.ts'
import { waitForLogin, waitForLoginPage } from '../cdp/login.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import { PluginError, userMessage } from '../shared/errors.ts'

/** Tool name as the model sees it. */
export const LOGIN_TOOL_NAME = 'job_ledger_login'

/** Model-facing description. */
export const LOGIN_TOOL_DESCRIPTION =
  '打开 BOSS 登录页并等待扫码（默认最多 3 分钟）。登录态保存在插件专用 Chrome profile 里，之后不用重复登录。'

/** What the tool returns. */
export type LoginToolResult =
  | {
      readonly ok: true
      /** True when the session was already valid and nothing was waited for. */
      readonly alreadyLoggedIn: boolean
      readonly url: string
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Knobs tests pin. */
export interface LoginToolOptions {
  readonly timeoutMs?: number | undefined
  /**
   * How long to look for the login wall after opening a protected page.
   *
   * The first navigation in a cold profile is slow (DNS, TLS, the SPA boot), and BOSS redirects to
   * the wall only once the app runs — observed at ~4 s on a fresh `--user-data-dir`, well after the
   * 1.25 s guard used on page reads. A short probe reports "already logged in" while the window
   * that is actually open shows the QR code.
   */
  readonly probeMs?: number | undefined
  readonly pollMs?: number | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
}

/**
 * Make sure the session is logged in, waiting for a scan when it is not.
 *
 * @param provider browser access
 * @param options wait budget, for tests and for a caller that cannot wait three minutes
 * @returns the state and where the browser ended up
 */
export async function loginForModel(
  provider: ReaderProvider,
  options: LoginToolOptions = {},
): Promise<LoginToolResult> {
  try {
    const reader = await provider.reader()

    const before = await reader.currentUrl()
    if (!isLoginUrl(before)) {
      if (isBossUrl(before)) {
        return { ok: true, alreadyLoggedIn: true, url: before }
      }

      // A freshly launched browser reports `about:blank`; "not the login page" there says nothing
      // about the session. Ask a page that requires one and wait for the redirect if it comes.
      await reader.navigate(BOSS_URLS.resume)
      const wall = await waitForLoginPage(reader, {
        timeoutMs: options.probeMs ?? 8_000,
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      })
      if (!wall) return { ok: true, alreadyLoggedIn: true, url: await reader.currentUrl() }
    }

    // Put the QR code in front of the person: the window may be on a page that only shows a splash.
    await reader.navigate(BOSS_URLS.login)

    // The page opens on SMS login; switch to the QR tab when the tab is there. A redesign must not
    // break logging in, so a missing tab is ignored — the person can still choose SMS.
    try {
      await reader.click(BOSS_SELECTORS.loginQrSwitch, 2_000)
    } catch {
      // Best effort by design.
    }

    // Absorb the moment where the browser still reports the previous page.
    const arrived = await waitForLoginPage(reader, {
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    })

    if (!arrived) {
      // The page can leave the login URL before the first look (a fast scan). Confirm on a protected
      // page rather than trusting one stale reading.
      await reader.navigate(BOSS_URLS.resume)
      const after = await reader.currentUrl()
      if (!isLoginUrl(after)) {
        return { ok: true, alreadyLoggedIn: false, url: after }
      }
    }

    const loggedIn = await waitForLogin(reader, {
      assumeLoginSeen: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    })

    if (!loggedIn) {
      return {
        ok: false,
        code: 'E_LOGIN_REQUIRED',
        message:
          '登录等待超时：请在弹出的 Chrome 窗口里完成扫码后重试（登录态会保存在专用 profile 里）',
      }
    }

    return { ok: true, alreadyLoggedIn: false, url: await reader.currentUrl() }
  } catch (error) {
    if (error instanceof PluginError) {
      return { ok: false, code: error.code, message: userMessage(error.code, error.values) }
    }
    throw error
  }
}

/**
 * Render the result.
 *
 * @param result tool result @returns one line for the model
 */
export function renderLoginResult(result: LoginToolResult): string {
  if (!result.ok) return `[${result.code}] ${result.message}`
  return result.alreadyLoggedIn
    ? `已登录：${result.url}`
    : `登录成功：${result.url}（登录态已保存，下次不用再扫）`
}
