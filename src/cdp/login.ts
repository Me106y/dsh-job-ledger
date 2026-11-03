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

/**
 * Throw `E_LOGIN_REQUIRED` when the page ended up on the login wall.
 *
 * The captures armed before navigation will never resolve in that case; they are swallowed here so
 * their eventual rejections do not surface as unhandled.
 *
 * @param browser reader positioned on the page
 * @param pending capture promises to discard when the check fails
 * @throws PluginError `E_LOGIN_REQUIRED`
 */
export async function assertLoggedIn(
  browser: BrowserReader,
  pending: readonly Promise<unknown>[],
): Promise<void> {
  if (!isLoginUrl(await browser.currentUrl())) return
  for (const promise of pending) promise.catch(() => undefined)
  throw new PluginError('E_LOGIN_REQUIRED')
}
