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
export interface ResumePayloads {
  readonly baseinfo: unknown
  readonly expect: unknown
  readonly status: unknown
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
  /** Number of captures armed at the moment `navigate` was called. */
  capturesAtNavigate: number | undefined

  #payloads: ResumePayloads

  /** @param payloads what each endpoint returns */
  constructor(payloads: ResumePayloads) {
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
    if (source.includes('baseinfo')) return this.#payloads.baseinfo
    if (source.includes('expect')) return this.#payloads.expect
    return this.#payloads.status
  }

  /** @returns an empty PNG */
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0)
  }
}
