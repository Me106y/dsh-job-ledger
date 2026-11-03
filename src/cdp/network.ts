/**
 * Response capture: the only way this plugin gets data out of the browser (TECH §5.3).
 *
 * Nothing here sends a request, builds a URL or signs a header. It waits for the page to make its
 * own request and reads the body Chrome already buffered. That distinction is the whole compliance
 * story (PRD §5.1, hard rule C3), so keep every platform read flowing through this function.
 *
 * @module dsh-job-ledger/cdp/network
 */

import { PluginError } from '../shared/errors.ts'
import type { CdpSession } from './session.ts'

/** Default budget for one response to appear. */
export const CAPTURE_TIMEOUT_MS = 20_000

/** How long a failed body read waits before the single retry. */
const BODY_RETRY_DELAY_MS = 80

/**
 * Test a URL against a pattern without letting a `/g` flag make the result depend on the last call.
 *
 * @param pattern pattern from the platform adapter
 * @param url response URL
 * @returns whether the URL matches
 */
function matches(pattern: RegExp, url: string): boolean {
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0
  return pattern.test(url)
}

/**
 * Wait for a response whose URL matches `pattern`.
 *
 * The caller must arm this **before** triggering the navigation, otherwise the response can arrive
 * first and be missed.
 *
 * @param session CDP session with the Network domain enabled
 * @param pattern URL pattern
 * @param timeoutMs how long to wait for the response body
 * @returns the parsed JSON body
 * @throws PluginError `E_NAV_TIMEOUT` when no response appears, `E_BODY_UNAVAILABLE` when the body cannot be read or parsed
 */
export async function captureResponse(
  session: CdpSession,
  pattern: RegExp,
  timeoutMs: number = CAPTURE_TIMEOUT_MS,
): Promise<unknown> {
  const requestId = await waitForRequest(session, pattern, timeoutMs)
  const raw = await readBody(session, requestId, pattern)
  return parseJsonBody(raw, pattern)
}

/**
 * @param session CDP session
 * @param pattern URL pattern
 * @param timeoutMs budget
 * @returns the CDP request id of the first matching response
 */
function waitForRequest(
  session: CdpSession,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new PluginError('E_NAV_TIMEOUT', { what: pattern.source }))
    }, timeoutMs)

    const off = session.on('Network.responseReceived', (params) => {
      const response = params.response
      if (typeof response !== 'object' || response === null) return
      const url = (response as { url?: unknown }).url
      if (typeof url !== 'string' || !matches(pattern, url)) return
      const requestId = params.requestId
      if (typeof requestId !== 'string') return
      clearTimeout(timer)
      off()
      resolve(requestId)
    })
  })
}

/**
 * @param session CDP session
 * @param requestId CDP request id
 * @param pattern pattern, for the error message
 * @returns the response body as text
 */
async function readBody(
  session: CdpSession,
  requestId: string,
  pattern: RegExp,
): Promise<string> {
  const read = async (): Promise<string> => {
    const result = await session.call<{ body?: unknown; base64Encoded?: unknown }>(
      'Network.getResponseBody',
      { requestId },
    )
    const body = typeof result.body === 'string' ? result.body : ''
    return result.base64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body
  }

  try {
    return await read()
  } catch {
    // The body is occasionally not buffered the instant the headers arrive; one short retry
    // covers it without turning a real failure into a long hang.
    await new Promise<void>((resolve) => setTimeout(resolve, BODY_RETRY_DELAY_MS))
    try {
      return await read()
    } catch {
      throw new PluginError('E_BODY_UNAVAILABLE', { what: pattern.source })
    }
  }
}

/**
 * Parse a response body as JSON.
 *
 * @param raw body text
 * @param pattern pattern, for the error message
 * @returns the parsed value
 * @throws PluginError `E_BODY_UNAVAILABLE` when the body is not JSON
 */
export function parseJsonBody(raw: string, pattern: RegExp): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new PluginError('E_BODY_UNAVAILABLE', { what: `${pattern.source} (not JSON)` })
  }
}
