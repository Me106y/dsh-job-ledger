/**
 * Owns the browser across tool calls.
 *
 * Launching Chrome is slow and the login only exists in that one profile, so the reader is created
 * once and reused. Two calls arriving together must not race into two launches, hence the shared
 * in-flight promise rather than a boolean.
 *
 * @module dsh-job-ledger/runtime/browser
 */

import { join } from 'node:path'

import { CdpReader } from '../cdp/browser.ts'
import type { BrowserPort } from '../cdp/browser.ts'
import { ensureChrome, findPageTarget } from '../cdp/chrome.ts'
import type { ChromeDeps } from '../cdp/chrome.ts'
import type { LedgerConfig } from '../config.ts'
import { PluginError } from '../shared/errors.ts'

/** Seams used by tests; production runs with the defaults. */
export interface BrowserRuntimeDeps {
  readonly chrome?: ChromeDeps | undefined
  readonly openReader?: ((webSocketUrl: string) => Promise<BrowserPort>) | undefined
  /** Resolves the page target to attach to; injected in tests so no real Chrome is needed. */
  readonly pageTarget?:
    | ((port: number) => Promise<{ webSocketDebuggerUrl: string } | undefined>)
    | undefined
}

/** What the tools actually need: a reader, however it is obtained. */
export interface ReaderProvider {
  reader(): Promise<BrowserPort>
}

/** Lazily-opened, shared browser connection. */
export class BrowserRuntime implements ReaderProvider {
  readonly #config: LedgerConfig
  readonly #deps: BrowserRuntimeDeps
  #reader: BrowserPort | undefined
  #opening: Promise<BrowserPort> | undefined
  #launched: boolean | undefined

  /**
   * @param config resolved configuration (data dir, port, explicit binary)
   * @param deps test seams
   */
  constructor(config: LedgerConfig, deps: BrowserRuntimeDeps = {}) {
    this.#config = config
    this.#deps = deps
  }

  /**
   * Get the reader, launching and connecting on first use.
   *
   * @returns the shared reader
   */
  async reader(): Promise<BrowserPort> {
    if (this.#reader !== undefined) return this.#reader
    this.#opening ??= this.#open()
    try {
      return await this.#opening
    } finally {
      this.#opening = undefined
    }
  }

  /** @returns whether this process started the browser, once it is known */
  get launched(): boolean | undefined {
    return this.#launched
  }

  /** Close the CDP connection. The browser itself is detached and stays open. */
  close(): void {
    this.#reader?.close()
    this.#reader = undefined
  }

  async #open(): Promise<BrowserPort> {
    const handle = await ensureChrome(
      {
        debugPort: this.#config.debugPort,
        profileDir: join(this.#config.dataDir, 'chrome-profile'),
        ...(this.#config.chromePath === '' ? {} : { chromePath: this.#config.chromePath }),
      },
      this.#deps.chrome ?? {},
    )
    this.#launched = handle.launched

    // Page commands require a page target; the browser-level socket rejects `Page.enable`.
    const findTarget = this.#deps.pageTarget ?? findPageTarget
    const page = await findTarget(handle.port)
    if (page === undefined) {
      throw new PluginError('E_CDP_DISCONNECTED', { what: 'no page target in the debugged Chrome' })
    }

    const open = this.#deps.openReader ?? CdpReader.open
    const reader = await open(page.webSocketDebuggerUrl)
    this.#reader = reader
    return reader
  }
}
