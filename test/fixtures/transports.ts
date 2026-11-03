/**
 * Test doubles for the CDP layer.
 *
 * @module dsh-job-ledger/test/fixtures/transports
 */

import type { BrowserReader } from '../../src/cdp/browser.ts'
import type { CdpTransport } from '../../src/cdp/session.ts'

/** A CDP request frame as the session sends it. */
export interface SentFrame {
  readonly id?: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** An in-memory transport: the test plays the browser. */
export class FakeTransport implements CdpTransport {
  readonly sent: SentFrame[] = []
  closed = false

  #messages: ((text: string) => void)[] = []
  #closes: (() => void)[] = []

  send(text: string): void {
    this.sent.push(JSON.parse(text) as SentFrame)
  }

  close(): void {
    this.closed = true
    for (const handler of this.#closes) handler()
  }

  onMessage(handler: (text: string) => void): void {
    this.#messages.push(handler)
  }

  onClose(handler: () => void): void {
    this.#closes.push(handler)
  }

  /** @param frame pretend the browser sent this */
  receive(frame: unknown): void {
    const text = JSON.stringify(frame)
    for (const handler of this.#messages) handler(text)
  }

  /** @param method CDP method @returns every request with that method, in order */
  requestsFor(method: string): SentFrame[] {
    return this.sent.filter((frame) => frame.method === method)
  }
}

/** Payloads keyed by the endpoint they belong to. */
export interface BrowserPayloads {
  readonly baseinfo?: unknown
  readonly expect?: unknown
  readonly status?: unknown
  readonly search?: unknown
  readonly recommend?: unknown
  readonly deliver?: unknown
}

/**
 * A browser that answers with fixed payloads.
 *
 * It also records *when* navigation happened relative to capture arming, because arming the three
 * captures after navigating is the bug this layer exists to avoid.
 */
export class ReplayBrowser implements BrowserReader {
  readonly patterns: RegExp[] = []
  navigated: string | undefined
  /** Where the fake page claims to be; tests set it to a login URL to simulate a redirect. */
  url = 'https://www.zhipin.com/web/geek/resume'
  closed = false
  /** Number of captures armed at the moment `navigate` was called. */
  capturesAtNavigate: number | undefined

  #payloads: BrowserPayloads

  /** @param payloads what each endpoint returns */
  constructor(payloads: BrowserPayloads) {
    this.#payloads = payloads
  }

  /** @param url page to open */
  async navigate(url: string): Promise<void> {
    this.navigated = url
    this.capturesAtNavigate = this.patterns.length
    await Promise.resolve()
  }

  /** @param pattern endpoint @returns its payload */
  async capture(pattern: RegExp): Promise<unknown> {
    this.patterns.push(pattern)
    const source = pattern.source
    if (source.includes('deliver')) return this.#payloads.deliver
    if (source.includes('joblist')) return this.#payloads.search
    if (source.includes('recommend')) return this.#payloads.recommend
    if (source.includes('baseinfo')) return this.#payloads.baseinfo
    if (source.includes('expect')) return this.#payloads.expect
    return this.#payloads.status
  }

  /** @returns an empty PNG */
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0)
  }

  /** @returns the configured page URL */
  async currentUrl(): Promise<string> {
    return this.url
  }

  readonly clicked: string[] = []
  readonly typed: { selector: string; text: string }[] = []
  /** Text returned for each selector; unknown selectors read as empty. */
  texts = new Map<string, string>()
  /** When set, `click` rejects with this error (used to test best-effort clicks). */
  clickError: unknown

  /** @param selector element to click @param timeoutMs ignored */
  async click(selector: string, timeoutMs = 0): Promise<void> {
    void timeoutMs
    if (this.clickError !== undefined) throw this.clickError
    this.clicked.push(selector)
  }

  /** @param selector input element @param text what to insert */
  async typeText(selector: string, text: string): Promise<void> {
    this.typed.push({ selector, text })
  }

  /** @param selector element @returns whether it is considered present */
  async waitFor(selector: string): Promise<boolean> {
    return this.texts.has(selector) || selector === 'body'
  }

  /** @param selector element @returns its configured text */
  async text(selector: string): Promise<string> {
    return this.texts.get(selector) ?? ''
  }

  /** Mark the reader closed. */
  close(): void {
    this.closed = true
  }
}
