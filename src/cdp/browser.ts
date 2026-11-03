/**
 * The browser surface the rest of the plugin is allowed to use (TECH §17.3).
 *
 * Tests substitute a replay implementation, so dedupe, run and reconcile never need a browser. The
 * interface is deliberately small: navigating, capturing a response the page made itself, and a
 * screenshot as evidence.
 *
 * Clicking and typing (`BrowserPort` proper) arrive at P3 together with the apply path, so this
 * reader cannot be mistaken for something that can submit an application.
 *
 * @module dsh-job-ledger/cdp/browser
 */

import { PluginError } from '../shared/errors.ts'
import { captureResponse } from './network.ts'
import { CdpSession } from './session.ts'
import type { CdpEvent } from './session.ts'
import { webSocketTransport } from './transport.ts'

/** What a reader can do with the browser. */
export interface BrowserReader {
  navigate(url: string): Promise<void>
  capture(pattern: RegExp, timeoutMs?: number): Promise<unknown>
  screenshot(): Promise<Buffer>
}

/** Default budget for a page to fire `load`. */
export const NAVIGATE_TIMEOUT_MS = 20_000

/**
 * @param session CDP session
 * @param method event name
 * @param timeoutMs budget
 * @returns the event params
 */
function waitForEvent(
  session: CdpSession,
  method: string,
  timeoutMs: number,
): Promise<CdpEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new PluginError('E_NAV_TIMEOUT', { what: method }))
    }, timeoutMs)

    const off = session.on(method, (params) => {
      clearTimeout(timer)
      off()
      resolve({ method, params })
    })
  })
}

/**
 * The real reader, on top of {@link CdpSession}.
 *
 * Opening enables the Page and Network domains, because capture is dead without Network and
 * navigation is dead without Page.
 */
export class CdpReader implements BrowserReader {
  readonly #session: CdpSession

  private constructor(session: CdpSession) {
    this.#session = session
  }

  /**
   * Open a CDP connection and enable the domains this reader needs.
   *
   * @param webSocketUrl `webSocketDebuggerUrl`
   * @returns the reader
   */
  static async open(webSocketUrl: string): Promise<CdpReader> {
    const session = new CdpSession(await webSocketTransport(webSocketUrl))
    try {
      await session.call('Page.enable')
      await session.call('Network.enable')
    } catch (error) {
      session.close()
      throw error
    }
    return new CdpReader(session)
  }

  /**
   * Navigate and wait for `load`.
   *
   * @param url target page
   */
  async navigate(url: string): Promise<void> {
    const loaded = waitForEvent(this.#session, 'Page.loadEventFired', NAVIGATE_TIMEOUT_MS)
    // Arm the wait before navigating: a fast page can fire `load` before the call resolves.
    await this.#session.call('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS)
    await loaded
  }

  /**
   * @param pattern URL pattern the page must have requested itself
   * @param timeoutMs budget
   * @returns the parsed body
   */
  capture(pattern: RegExp, timeoutMs?: number): Promise<unknown> {
    return captureResponse(
      this.#session,
      pattern,
      timeoutMs ?? undefined,
    )
  }

  /** @returns a PNG of the current viewport */
  async screenshot(): Promise<Buffer> {
    const result = await this.#session.call<{ data?: unknown }>('Page.captureScreenshot', {
      format: 'png',
    })
    if (typeof result.data !== 'string') {
      throw new PluginError('E_BODY_UNAVAILABLE', { what: 'screenshot' })
    }
    return Buffer.from(result.data, 'base64')
  }

  /** Close the underlying connection. */
  close(): void {
    this.#session.close()
  }
}
