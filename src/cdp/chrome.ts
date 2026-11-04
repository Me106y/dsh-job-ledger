/**
 * Chrome lifecycle: find it, start it with a dedicated profile, wait for the debug port (TECH §5.1).
 *
 * The browser is the user's own, launched with a separate `--user-data-dir` so the plugin never
 * touches their daily profile and the login can be reused between runs. Everything is injectable
 * so the decision logic (which binary, which args, when to give up) is testable without spawning
 * a process.
 *
 * @module dsh-job-ledger/cdp/chrome
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { PluginError } from '../shared/errors.ts'

/** Default port. 9222 is the conventional Chrome debug port. */
export const DEFAULT_DEBUG_PORT = 9222

/** How long to keep polling after launch. */
const STARTUP_TIMEOUT_MS = 15_000

/** Poll interval while waiting for the debug port. */
const POLL_INTERVAL_MS = 200

/** What `/json/version` told us. */
export interface DebugTarget {
  readonly webSocketDebuggerUrl: string
  readonly browser: string
}

/** Where to launch, and with what. */
export interface ChromeOptions {
  readonly debugPort: number
  /** Dedicated profile directory; created by Chrome on first run. */
  readonly profileDir: string
  /** Explicit binary, or `undefined` to auto-detect. */
  readonly chromePath?: string
}

/** A browser ready to talk CDP. */
export interface ChromeHandle {
  readonly webSocketUrl: string
  readonly port: number
  readonly launched: boolean
}

/** Injectable seams. Production uses the defaults; tests pass fakes. */
export interface ChromeDeps {
  readonly platform?: NodeJS.Platform | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly exists?: ((path: string) => boolean) | undefined
  readonly probe?: ((port: number) => Promise<DebugTarget | undefined>) | undefined
  readonly launch?: ((binary: string, args: readonly string[]) => void) | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /** Startup budget override; tests shrink it so they do not wait 15 seconds. */
  readonly startupTimeoutMs?: number | undefined
}

/**
 * Well-known Chrome binaries per platform, most likely first.
 *
 * @param platform Node platform
 * @param env environment, for `PROGRAMFILES` on Windows
 * @returns candidate absolute paths
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (root): root is string => typeof root === 'string',
    )
    return roots.flatMap((root) => [
      `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ])
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

/**
 * Command line for a dedicated debugging profile.
 *
 * `--remote-allow-origins=*` is required by Chrome 111+ when the client sends an `Origin` header;
 * the port is bound to loopback, so this does not widen exposure beyond the machine.
 *
 * @param options launch options
 * @returns argv, without the binary
 */
export function launchArgs(options: ChromeOptions): readonly string[] {
  return [
    `--remote-debugging-port=${String(options.debugPort)}`,
    `--user-data-dir=${options.profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ]
}

/**
 * Ask a running Chrome for its debugger URL.
 *
 * @param port debug port
 * @returns the target, or `undefined` when nothing is listening
 */
export async function probeDebugPort(port: number): Promise<DebugTarget | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      webSocketDebuggerUrl?: unknown
      Browser?: unknown
    }
    if (typeof body.webSocketDebuggerUrl !== 'string') return undefined
    return {
      webSocketDebuggerUrl: body.webSocketDebuggerUrl,
      browser: typeof body.Browser === 'string' ? body.Browser : 'unknown',
    }
  } catch {
    return undefined
  }
}

/**
 * Ask a running Chrome for its page targets.
 *
 * The browser-level WebSocket from `/json/version` only accepts browser commands: `Page.enable`
 * answers "'Page.enable' wasn't found" there. Page commands (navigate, DOM, screenshots) live on a
 * page target, so the reader must connect to one of these.
 *
 * @param port debug port
 * @param fetchImpl injectable fetch, for tests
 * @returns the first page target, or undefined
 */
/** Pages the plugin may drive: its own blank tab, or a BOSS tab it opened earlier. */
export function isPluginPage(url: string): boolean {
  return url === 'about:blank' || /^https?:\/\/(?:[\w-]+\.)*zhipin\.com\//i.test(url)
}

/** @param port debug port @param fetchImpl injectable fetch @returns every page target */
async function pageTargets(port: number, fetchImpl: typeof fetch): Promise<DebugTarget[]> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${String(port)}/json/list`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return []
    const body = (await response.json()) as unknown
    if (!Array.isArray(body)) return []

    const pages: DebugTarget[] = []
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) continue
      const target = entry as { type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }
      if (target.type !== 'page') continue
      if (typeof target.webSocketDebuggerUrl !== 'string') continue
      pages.push({
        webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        browser: typeof target.url === 'string' ? target.url : 'about:blank',
      })
    }
    return pages
  } catch {
    return []
  }
}

/** @param port debug port @param fetchImpl injectable fetch @returns a new blank tab, if Chrome made one */
async function openPageTarget(port: number, fetchImpl: typeof fetch): Promise<DebugTarget | undefined> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${String(port)}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown; url?: unknown }
    if (typeof body.webSocketDebuggerUrl !== 'string') return undefined
    return {
      webSocketDebuggerUrl: body.webSocketDebuggerUrl,
      browser: typeof body.url === 'string' ? body.url : 'about:blank',
    }
  } catch {
    return undefined
  }
}

/**
 * Choose the page target to drive.
 *
 * Only a BOSS tab or a blank one is eligible: a debugged Chrome can hold the user's own tabs (the
 * DSH panel itself lives at `127.0.0.1:3080`), and navigating one of those would replace the page
 * they are using. When no plugin page exists, a new tab is opened instead of borrowing theirs.
 *
 * @param port debug port
 * @param fetchImpl injectable fetch, for tests
 * @returns the target to attach to, or undefined when Chrome offers none
 */
export async function findPageTarget(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DebugTarget | undefined> {
  const pages = await pageTargets(port, fetchImpl)
  const preferred = pages.find((page) => /zhipin\.com\//i.test(page.browser))
    ?? pages.find((page) => page.browser === 'about:blank')
  if (preferred !== undefined) return preferred
  return openPageTarget(port, fetchImpl)
}

/**
 * Get a Chrome that speaks CDP on the requested port, launching one if necessary.
 *
 * Reuse comes first: a browser already listening is the one the user logged into, and starting a
 * second one would lose that session.
 *
 * @param options where and with what
 * @param deps injectable seams
 * @returns a ready handle
 * @throws PluginError `E_CHROME_NOT_FOUND` when no binary exists, `E_CHROME_NOT_STARTED` when it does not come up
 */
export async function ensureChrome(
  options: ChromeOptions,
  deps: ChromeDeps = {},
): Promise<ChromeHandle> {
  const probe = deps.probe ?? probeDebugPort
  const exists = deps.exists ?? existsSync
  const launch = deps.launch ?? defaultLaunch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const running = await probe(options.debugPort)
  if (running !== undefined) {
    return { webSocketUrl: running.webSocketDebuggerUrl, port: options.debugPort, launched: false }
  }

  const candidates =
    options.chromePath !== undefined
      ? [options.chromePath]
      : chromeCandidates(deps.platform ?? process.platform, deps.env ?? process.env)
  const binary = candidates.find((path) => exists(path))
  if (binary === undefined) {
    throw new PluginError('E_CHROME_NOT_FOUND', { paths: candidates.join(', ') })
  }

  launch(binary, launchArgs(options))

  const deadline = Date.now() + (deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const target = await probe(options.debugPort)
    if (target !== undefined) {
      return { webSocketUrl: target.webSocketDebuggerUrl, port: options.debugPort, launched: true }
    }
  }
  throw new PluginError('E_CHROME_NOT_STARTED', { port: String(options.debugPort) })
}

/**
 * Start Chrome detached, so it outlives this process and the login survives a restart.
 *
 * @param binary resolved Chrome path
 * @param args argv
 */
function defaultLaunch(binary: string, args: readonly string[]): void {
  try {
    const child = spawn(binary, [...args], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    throw new PluginError('E_CHROME_NOT_STARTED', { what: String(error) })
  }
}
