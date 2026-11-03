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
  /** Where the page actually ended up; navigating can redirect to the login wall. */
  currentUrl(): Promise<string>
  /** Release the connection. The browser process is left running on purpose. */
  close(): void
}

/**
 * A browser that can also act (TECH §5.5, §17.3).
 *
 * Clicks go through `Input.dispatchMouseEvent`, never `element.click()`: the synthetic event is
 * `isTrusted: false`, which the platform can tell apart. Typing goes through `Input.insertText`
 * after a real `focus()`, because assigning `element.value` does not fire React's onChange and the
 * page treats the box as empty.
 */
export interface BrowserPort extends BrowserReader {
  /** Click an element by selector, scrolling it into view first. */
  click(selector: string, timeoutMs?: number): Promise<void>
  /** Focus an element and insert text into it. */
  typeText(selector: string, text: string, timeoutMs?: number): Promise<void>
  /** Wait until a selector exists; resolves false on timeout instead of throwing. */
  waitFor(selector: string, timeoutMs: number): Promise<boolean>
  /** Read an element's innerText (empty string when absent). */
  text(selector: string): Promise<string>
}

/** How often the DOM is polled while waiting for a selector. */
const DOM_POLL_MS = 150

/** @param ms milliseconds @returns a promise that settles afterwards */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Default budget for a page to fire `load`. */
export const NAVIGATE_TIMEOUT_MS = 20_000

/**
 * Extract the current URL from a `Page.getNavigationHistory` result.
 *
 * Kept pure so the fallback logic is testable without a browser: the point of using history at all
 * is that a blocked renderer cannot answer, which is exactly the case a test double would miss.
 *
 * @param history CDP result
 * @returns the URL, or undefined when the result is unusable
 */
export function navigationUrl(history: {
  readonly currentIndex?: number | undefined
  readonly entries?: readonly { readonly url?: string | undefined }[] | undefined
}): string | undefined {
  const index = history.currentIndex ?? -1
  if (index < 0) return undefined
  const url = history.entries?.[index]?.url
  return typeof url === 'string' && url !== '' ? url : undefined
}

/** How long to let a page settle after the main frame committed. */
const NAVIGATE_SETTLE_MS = 800

/**
 * Resolve when any of the named events arrives.
 *
 * `load` is not enough on its own: a first visit to a site with slow third-party resources can leave
 * it pending far longer than a person would wait, while the document is already navigable.
 *
 * @param session CDP session
 * @param methods event names, in no particular order
 * @param timeoutMs budget
 * @returns the event that arrived
 */
function waitForAnyEvent(
  session: CdpSession,
  methods: readonly string[],
  timeoutMs: number,
): Promise<CdpEvent> {
  return new Promise((resolve, reject) => {
    const offs: (() => void)[] = []
    const timer = setTimeout(() => {
      for (const off of offs) off()
      reject(new PluginError('E_NAV_TIMEOUT', { what: methods.join(' / ') }))
    }, timeoutMs)

    for (const method of methods) {
      offs.push(
        session.on(method, (params) => {
          clearTimeout(timer)
          for (const off of offs) off()
          resolve({ method, params })
        }),
      )
    }
  })
}

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
export class CdpReader implements BrowserPort {
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
    // Arm the wait before navigating: a fast page can fire `load` before the call resolves.
    const settled = waitForAnyEvent(
      this.#session,
      ['Page.loadEventFired', 'Page.frameNavigated'],
      NAVIGATE_TIMEOUT_MS,
    )
    await this.#session.call('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS)
    const event = await settled

    // A committed frame only means "started"; give the document a moment to become usable. `load`
    // needs no such grace period.
    if (event.method === 'Page.frameNavigated') {
      await new Promise<void>((resolve) => setTimeout(resolve, NAVIGATE_SETTLE_MS))
    }
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

  /**
   * Read the live location, so a redirect to the login wall is detectable.
   *
   * The browser reports navigation history without asking the renderer, which matters on pages
   * whose main thread is blocked (BOSS's anti-bot scripts are one): `Runtime.evaluate` can hang
   * there, while `Page.getNavigationHistory` still answers. The evaluate path stays as a fallback.
   *
   * @returns the current page URL
   */
  async currentUrl(): Promise<string> {
    try {
      const history = await this.#session.call<{
        currentIndex?: number
        entries?: { url?: string }[]
      }>('Page.getNavigationHistory', {}, 3_000)
      const url = navigationUrl(history)
      if (url !== undefined) return url
    } catch {
      // Fall through: a browser that answers evaluate but not history still works.
    }

    const result = await this.#session.call<{
      result?: { value?: unknown }
    }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 5_000)
    const value = result.result?.value
    if (typeof value !== 'string') {
      throw new PluginError('E_BODY_UNAVAILABLE', { what: 'location.href' })
    }
    return value
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * @param expression JavaScript source
   * @returns the value, or undefined when the page returned nothing
   */
  async #evaluate<T>(expression: string): Promise<T | undefined> {
    const result = await this.#session.call<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })
    return result.result?.value as T | undefined
  }

  /**
   * Find an element and return its clickable centre, scrolling it into view first.
   *
   * @param selector CSS selector
   * @returns the centre point, or undefined when the element is missing or has no box
   */
  #elementCentre(selector: string): Promise<{ x: number; y: number } | undefined> {
    const source = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`
    return this.#evaluate<{ x: number; y: number } | null>(source).then((value) => value ?? undefined)
  }

  /**
   * Click through real input events, retrying once because layout can move under the cursor.
   *
   * @param selector CSS selector
   * @param timeoutMs how long to wait for the element
   * @throws PluginError `E_SELECTOR_MISSING` when the element never appears
   */
  async click(selector: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let centre = await this.#elementCentre(selector)
      while (centre === undefined && Date.now() < deadline) {
        await delay(DOM_POLL_MS)
        centre = await this.#elementCentre(selector)
      }
      if (centre === undefined) break

      await this.#session.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: centre.x,
        y: centre.y,
      })
      await this.#session.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: centre.x,
        y: centre.y,
        button: 'left',
        clickCount: 1,
      })
      await this.#session.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: centre.x,
        y: centre.y,
        button: 'left',
        clickCount: 1,
      })

      // If the element vanished between measuring and clicking, the click went nowhere.
      const stillThere = await this.#elementCentre(selector)
      if (stillThere !== undefined) return
    }
    throw new PluginError('E_SELECTOR_MISSING', { what: selector })
  }

  /**
   * Focus an element and insert text into it.
   *
   * @param selector CSS selector
   * @param text text to insert
   * @param timeoutMs how long to wait for the element
   * @throws PluginError `E_SELECTOR_MISSING` when the element never appears
   */
  async typeText(selector: string, text: string, timeoutMs = 10_000): Promise<void> {
    if (!(await this.waitFor(selector, timeoutMs))) {
      throw new PluginError('E_SELECTOR_MISSING', { what: selector })
    }
    await this.#evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`)
    await this.#session.call('Input.insertText', { text })
  }

  /**
   * Wait for a selector to exist.
   *
   * @param selector CSS selector
   * @param timeoutMs budget
   * @returns whether it appeared
   */
  async waitFor(selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const present = await this.#evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      )
      if (present === true) return true
      if (Date.now() >= deadline) return false
      await delay(DOM_POLL_MS)
    }
  }

  /**
   * Read an element's text.
   *
   * @param selector CSS selector
   * @returns innerText, or the empty string when the element is absent
   */
  async text(selector: string): Promise<string> {
    const value = await this.#evaluate<string | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.innerText : null;
    })()`)
    return typeof value === 'string' ? value : ''
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
