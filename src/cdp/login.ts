/**
 * Login-wall guard shared by every page read.
 *
 * BOSS answers an expired session with a redirect, not a 401, so "are we on the login page?" is
 * the cheapest reliable check after a navigation. Doing it in one place keeps every reader from
 * inventing its own 20-second timeout story.
 *
 * @module dsh-job-ledger/cdp/login
 */

import type { BrowserReader } from './browser.ts'
import { isLoginUrl } from './boss.ts'
import { PluginError } from '../shared/errors.ts'

/** How often the URL is re-read while waiting for a redirect. */
export const LOGIN_POLL_MS = 250

/** How many times. Six tries is 1.25s of grace — enough for a redirect, short enough to ignore. */
export const LOGIN_POLL_ATTEMPTS = 6

/** Seams used by tests. */
export interface LoginCheckOptions {
  readonly attempts?: number | undefined
  readonly intervalMs?: number | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
}

/**
 * Throw `E_LOGIN_REQUIRED` when the page ends up on the login wall.
 *
 * Observed on a real logged-out session: `…/web/geek/job` answers with a redirect to `/web/user/`,
 * but the redirect lands a moment *after* the frame commits, so a single check right after
 * navigation sees the old URL. Polling briefly closes that gap; without it the reader would wait
 * out a capture timeout and report a body error instead of "log in".
 *
 * The captures armed before navigation will never resolve in that case; they are swallowed here so
 * their eventual rejections do not surface as unhandled.
 *
 * @param browser reader positioned on the page
 * @param pending capture promises to discard when the check fails
 * @param options polling knobs
 * @throws PluginError `E_LOGIN_REQUIRED`
 */
export async function assertLoggedIn(
  browser: BrowserReader,
  pending: readonly Promise<unknown>[],
  options: LoginCheckOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? LOGIN_POLL_ATTEMPTS
  const intervalMs = options.intervalMs ?? LOGIN_POLL_MS
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isLoginUrl(await browser.currentUrl())) {
      for (const promise of pending) promise.catch(() => undefined)
      throw new PluginError('E_LOGIN_REQUIRED')
    }
    if (attempt < attempts - 1) await sleep(intervalMs)
  }
}
