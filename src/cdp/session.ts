/**
 * A minimal Chrome DevTools Protocol client (TECH §5.2).
 *
 * CDP over a local WebSocket is simple enough to hand-roll, which is what keeps the "zero native
 * dependencies" promise (PRD §7): no Playwright, no Puppeteer, no compiled addon. The whole client
 * is a request table, an event bus, and a close path.
 *
 * Transport is injected rather than constructed here, so the request/response and timeout
 * behaviour can be tested against a fake socket instead of a browser.
 *
 * @module dsh-job-ledger/cdp/session
 */

/** Failures that belong to the CDP layer itself. Callers map these to user-facing codes. */
export type CdpErrorKind = 'timeout' | 'disconnect' | 'protocol'

/**
 * A transport-level failure.
 *
 * Deliberately *not* in the error-code table: this never reaches a tool or the panel. The layer
 * that knows what was being attempted maps it to `E_CDP_DISCONNECTED`, `E_NAV_TIMEOUT` or
 * `E_BODY_UNAVAILABLE`, which are the codes a person can act on.
 */
export class CdpError extends Error {
  readonly kind: CdpErrorKind
  readonly method?: string

  /**
   * @param kind what went wrong
   * @param message developer-facing detail
   * @param method CDP method that failed, when known
   */
  constructor(kind: CdpErrorKind, message: string, method?: string) {
    super(message)
    this.name = 'CdpError'
    this.kind = kind
    if (method !== undefined) this.method = method
  }
}

/** A socket that can carry CDP frames. The real one wraps Node's global `WebSocket`. */
export interface CdpTransport {
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

/** A CDP event frame. */
export interface CdpEvent {
  readonly method: string
  readonly params: Record<string, unknown>
}

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

/** Default per-call timeout. A local socket that takes longer than this is not coming back. */
export const CDP_CALL_TIMEOUT_MS = 15_000

/**
 * One CDP connection.
 *
 * `call` resolves with the raw `result` object; typed wrappers live in `network.ts` and
 * `browser.ts`.
 */
export class CdpSession {
  #transport: CdpTransport
  #nextId = 1
  #pending = new Map<number, Pending>()
  #listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  #closed = false

  /** @param transport an already-open socket; `connect` builds the real one */
  constructor(transport: CdpTransport) {
    this.#transport = transport
    transport.onMessage((text) => {
      this.#receive(text)
    })
    transport.onClose(() => {
      this.#failPending(new CdpError('disconnect', 'the browser connection closed'))
    })
  }

  /**
   * Send a command and wait for its result.
   *
   * @param method CDP method, e.g. `Page.navigate`
   * @param params method parameters
   * @param timeoutMs how long to wait before rejecting with a timeout
   * @returns the command's `result` object
   */
  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = CDP_CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new CdpError('disconnect', 'session is closed', method))

    const id = this.#nextId
    this.#nextId += 1

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError('timeout', `${method} did not answer in ${String(timeoutMs)}ms`, method))
      }, timeoutMs)

      this.#pending.set(id, {
        method,
        resolve: (value) => {
          resolve(value as T)
        },
        reject,
        timer,
      })

      try {
        this.#transport.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new CdpError('disconnect', String(error), method))
      }
    })
  }

  /**
   * Subscribe to a CDP event.
   *
   * @param method event name, e.g. `Network.responseReceived`
   * @param handler called with the event's params
   * @returns an unsubscribe function
   */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    const set = this.#listeners.get(method) ?? new Set()
    set.add(handler)
    this.#listeners.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.#listeners.delete(method)
    }
  }

  /** Close the socket and reject anything still waiting. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#failPending(new CdpError('disconnect', 'session closed'))
    this.#transport.close()
    this.#listeners.clear()
  }

  /** @returns whether the session has been closed */
  get closed(): boolean {
    return this.#closed
  }

  #receive(text: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      // A malformed frame means a broken peer, not a broken user flow. Drop it; the call that
      // cares will time out and surface as a timeout.
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const message = frame as {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (message.error !== undefined) {
        pending.reject(
          new CdpError('protocol', message.error.message ?? 'CDP error', pending.method),
        )
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }

    if (typeof message.method !== 'string') return
    const params =
      typeof message.params === 'object' && message.params !== null
        ? (message.params as Record<string, unknown>)
        : {}
    for (const handler of this.#listeners.get(message.method) ?? []) handler(params)
  }

  #failPending(error: CdpError): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
