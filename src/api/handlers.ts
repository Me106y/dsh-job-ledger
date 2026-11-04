/**
 * Request handlers for the panel API (TECH §11).
 *
 * The handlers are plain functions over a request description, not tied to a web framework: the
 * route layer that mounts them on `ctx.webServer` is a few lines in the plugin entry, and the
 * behaviour — guards, view shapes, error mapping — is testable without an HTTP server.
 *
 * Two rules are enforced here rather than trusted to the client:
 *
 * - every request carries `x-job-ledger-request: 1`, a weak CSRF guard;
 * - every mutation goes through the ledger's single writer and its coded errors.
 *
 * @module dsh-job-ledger/api/handlers
 */

import type { AppState } from '../ledger/events.ts'
import type { Ledger } from '../ledger/store.ts'
import type { QueueFilter } from '../ledger/queue.ts'
import { skipJob } from '../ledger/skip.ts'
import type { ReaderProvider } from '../runtime/browser.ts'
import type { SettingsStore } from '../settings.ts'
import { parseSettingsInput } from '../settings.ts'
import { PluginError, userMessage } from '../shared/errors.ts'
import { discoverForModel } from '../tools/discover.ts'
import { readTracker, resolveTrackerPath, trackerFormat } from '../tracker/sheet.ts'
import { syncTracker } from '../tracker/sync.ts'
import type { DiscoverySource } from '../discover/read.ts'
import { reconcileForModel } from '../tools/reconcile.ts'
import type { RunStarter } from '../tools/apply.ts'
import type {
  ApiError,
  OverviewView,
  QueueUpdateView,
  QueueView,
  TrackerSyncView,
  TrackerView,
  ReconcileView,
  RunView,
  SettingsView,
} from './contract.ts'
import type { RunTracker } from './views.ts'
import {
  overviewView,
  queueView,
  QUEUE_PAGE_LIMIT,
  reconcileView,
  settingsView,
} from './views.ts'

/** Prefix every route lives under (TECH §11.1). */
export const API_PREFIX = '/job-ledger/api/'

/** Header that marks a request as coming from the panel. */
export const REQUEST_HEADER = 'x-job-ledger-request'

/** What a request looks like to a handler. */
export interface RouteRequest {
  readonly method: 'GET' | 'POST'
  /** Path below {@link API_PREFIX}, e.g. `queue` or `apps/a_1/state`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>> | undefined
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined
}

/** What a handler returns. */
export interface RouteResult {
  readonly status: number
  readonly body: unknown
}

/** Collaborators the handlers need. */
export interface ApiDeps {
  readonly ledger: Ledger
  readonly runner: RunStarter
  readonly provider: ReaderProvider
  readonly tracker: RunTracker
  /** Panel-editable target settings; also the profile the tools read. */
  readonly settings: SettingsStore
  readonly clock?: (() => number) | undefined
}

/** The API surface, keyed by `METHOD path`. */
export type ApiHandlers = (request: RouteRequest) => Promise<RouteResult>

/**
 * @param code error code @param values placeholders @returns the failure body
 */
function failure(code: PluginError['code'], values?: Readonly<Record<string, string>>): ApiError {
  return {
    error: userMessage(code, values),
    code,
    ...(values === undefined ? {} : { values }),
  }
}

/**
 * @param code error code @returns the HTTP status the panel should map
 */
function statusFor(code: PluginError['code']): number {
  switch (code) {
    case 'E_RUN_ACTIVE':
    case 'E_DAILY_QUOTA':
    case 'E_ILLEGAL_TRANSITION':
    case 'E_UNBALANCED':
    case 'E_ALREADY_APPLIED':
    case 'E_LEASE_HELD':
      return 409
    case 'E_INVALID_ARGUMENT':
    case 'E_NOT_CONFIGURED':
    case 'E_TRACKER_PATH':
      return 400
    case 'E_TRACKER_SHEET':
      return 502
    case 'E_LOGIN_REQUIRED':
    case 'E_STOKEN_EXPIRED':
      return 401
    case 'E_RATE_LIMITED':
    case 'E_ACCOUNT_RISK':
    case 'E_CAPTCHA':
      return 429
    default:
      return 500
  }
}

/**
 * Turn a thrown error into an HTTP result.
 *
 * @param error whatever was thrown
 * @returns the mapped result
 */
function toResult(error: unknown): RouteResult {
  if (error instanceof PluginError) {
    return { status: statusFor(error.code), body: failure(error.code, error.values) }
  }
  return {
    status: 500,
    body: failure('E_BODY_UNAVAILABLE', { what: error instanceof Error ? error.message : String(error) }),
  }
}

/**
 * Parse a queue filter from the query string.
 *
 * @param value raw query value @returns a valid filter, defaulting to `new`
 */
function filterOf(value: string | undefined): QueueFilter {
  return value === 'suspect' || value === 'filtered' ? value : 'new'
}

/**
 * Parse a page size.
 *
 * @param value raw query value @returns a positive limit capped at the payload size
 */
function limitOf(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return QUEUE_PAGE_LIMIT
  return Math.min(parsed, QUEUE_PAGE_LIMIT)
}

/**
 * Read a required field from an unknown body.
 *
 * @param body request body @param key field name @returns the value
 * @throws PluginError `E_INVALID_ARGUMENT` when it is missing
 */
function required<T>(body: unknown, key: string): T {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const value = record[key]
  if (value === undefined) {
    throw new PluginError('E_INVALID_ARGUMENT', { what: `missing ${key}` })
  }
  return value as T
}

/**
 * Build the request dispatcher.
 *
 * @param deps collaborators
 * @returns a function from request to result
 */
export function createApi(deps: ApiDeps): ApiHandlers {
  const clock = deps.clock ?? (() => Date.now())
  let lastReport: Parameters<typeof reconcileView>[1]

  const overview = (): OverviewView => {
    const now = clock()
    const view = overviewView(
      deps.ledger.projection,
      now,
      deps.tracker.run,
      lastReport?.discrepancies.length ?? 0,
    )
    return view
  }

  return async (request: RouteRequest): Promise<RouteResult> => {
    const header = request.headers?.[REQUEST_HEADER]
    if (header !== '1') {
      return {
        status: 403,
        body: failure('E_INVALID_ARGUMENT', { what: `missing ${REQUEST_HEADER} header` }),
      }
    }

    const segments = request.path.split('/').filter((segment) => segment !== '')
    const route = `${request.method} ${segments.join('/')}`

    try {
      if (route === 'GET queue') {
        const view: QueueView = queueView(
          deps.ledger.projection,
          filterOf(request.query?.['filter']),
          limitOf(request.query?.['limit']),
        )
        return { status: 200, body: view }
      }

      if (route === 'GET overview') return { status: 200, body: overview() }

      if (route === 'GET run') return { status: 200, body: deps.tracker.run }

      if (route === 'GET profile') {
        return {
          status: 200,
          body: settingsView(deps.settings, deps.ledger.projection.revision) satisfies SettingsView,
        }
      }

      if (route === 'POST profile') {
        let input = parseSettingsInput(request.body)
        // A path that does not exist (or is not a sheet) is rejected at save time, not after a run.
        // Finder hides extensions, so 「投递进度表」 resolves to 投递进度表.numbers and that is stored.
        if (input.trackerPath !== undefined && input.trackerPath !== '') {
          input = { ...input, trackerPath: resolveTrackerPath(input.trackerPath).path }
        }
        deps.settings.update(input, clock())
        return {
          status: 200,
          body: settingsView(deps.settings, deps.ledger.projection.revision) satisfies SettingsView,
        }
      }

      if (route === 'GET reconcile') {
        return {
          status: 200,
          body: reconcileView(deps.ledger.projection, lastReport) satisfies ReconcileView,
        }
      }

      if (route === 'POST run/start') {
        const ids = required<unknown>(request.body, 'ids')
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          throw new PluginError('E_INVALID_ARGUMENT', { what: 'ids must be a string array' })
        }
        deps.tracker.set({
          state: 'running',
          total: ids.length,
          done: 0,
          startedAt: new Date(clock()).toISOString(),
        })
        const result = await deps.runner.run({
          ids: ids as string[],
          grantedBy: { kind: 'panel', at: new Date(clock()).toISOString() },
        })
        const done = result.summary.submitted + result.summary.uncertain + result.summary.failed
        const view: RunView = {
          runId: result.runId,
          state: result.outcome,
          total: ids.length,
          done,
          ...(result.haltReason === undefined ? {} : { haltReason: result.haltReason }),
        }
        deps.tracker.set(view)
        return { status: 200, body: view }
      }

      if (route === 'POST reconcile/run') {
        const reconcileResult = await reconcileForModel(deps.provider, deps.ledger, {
          now: clock(),
        })
        if (!reconcileResult.ok) {
          return {
            status: 502,
            body: failure(reconcileResult.code as PluginError['code']),
          }
        }
        lastReport = {
          matched: reconcileResult.matched,
          backfilled: reconcileResult.backfilled,
          discrepancies: reconcileResult.discrepancies,
          platformOnly: reconcileResult.platformOnly,
          partial: reconcileResult.partial,
        }
        return {
          status: 200,
          body: reconcileView(deps.ledger.projection, lastReport),
        }
      }

      if (route === 'POST queue/update') {
        // Discovery drives the same browser page a run is clicking; a second tab left open must not
        // start a navigation in the middle of a run. A panel run is in the tracker; a model-started
        // run is visible only through the lease it holds while clicking.
        const now = clock()
        const clicking =
          deps.tracker.run.state === 'running' ||
          deps.tracker.run.state === 'queued' ||
          [...deps.ledger.projection.leases.values()].some(
            (lease) => Date.parse(lease.expiresAt) >= now,
          )
        if (clicking) return { status: 409, body: failure('E_RUN_ACTIVE') }
        const requested = (request.body as { source?: unknown } | undefined)?.source
        const source: DiscoverySource = requested === 'recommend' ? 'recommend' : 'search'
        // The live profile, not the YAML one: the panel's settings are what "current target" means.
        const discovered = await discoverForModel(deps.provider, deps.ledger, deps.settings.profile, {
          source,
          now: clock(),
        })
        if (!discovered.ok) {
          const code = discovered.code as PluginError['code']
          return { status: statusFor(code), body: failure(code) }
        }
        const view: QueueUpdateView = {
          revision: deps.ledger.projection.revision,
          source: discovered.source,
          added: discovered.added,
          duplicates: discovered.duplicates,
          filtered: discovered.filtered,
          suspects: discovered.suspects,
          invalid: discovered.invalid,
          queue: queueView(deps.ledger.projection, 'new', QUEUE_PAGE_LIMIT),
        }
        return { status: 200, body: view }
      }

      if (route === 'GET tracker') {
        const path = deps.settings.profile.tracker.path
        const format = trackerFormat(path) ?? 'none'
        const base: TrackerView = { revision: deps.ledger.projection.revision, path, format, headers: [] }
        if (path === '' || format === 'none') return { status: 200, body: base }
        try {
          const data = await readTracker(path)
          return { status: 200, body: { ...base, headers: [...data.header] } }
        } catch (error) {
          const code = error instanceof PluginError ? error.code : 'E_TRACKER_SHEET'
          const values = error instanceof PluginError ? error.values : undefined
          return { status: 200, body: { ...base, error: { code, message: userMessage(code, values) } } }
        }
      }

      if (route === 'POST tracker/sync') {
        const path = deps.settings.profile.tracker.path
        if (path === '') throw new PluginError('E_TRACKER_PATH', { what: '还没有配置投递表' })
        const synced = await syncTracker(deps.ledger, path, clock())
        const view: TrackerSyncView = {
          revision: deps.ledger.projection.revision,
          imported: synced.imported,
          matched: synced.matched,
          written: synced.written,
        }
        return { status: 200, body: view }
      }

      const skipMatch = /^POST jobs\/([^/]+)\/skip$/.exec(`${request.method} ${request.path}`)
      if (skipMatch !== null) {
        const jobId = decodeURIComponent(skipMatch[1] ?? '')
        const result = skipJob(deps.ledger, jobId, new Date(clock()).toISOString())
        return { status: 200, body: { jobId: result.jobId, status: result.status } }
      }

      const stateMatch = /^POST apps\/([^/]+)\/state$/.exec(`${request.method} ${request.path}`)
      if (stateMatch !== null) {
        const appId = decodeURIComponent(stateMatch[1] ?? '')
        const state = required<AppState>(request.body, 'state')
        const note = (request.body as { note?: unknown }).note
        deps.ledger.append({
          type: 'app/state',
          appId,
          state,
          ...(typeof note === 'string' ? { note } : {}),
          at: new Date(clock()).toISOString(),
        })
        return { status: 200, body: { appId, state } }
      }

      return { status: 404, body: failure('E_INVALID_ARGUMENT', { what: `unknown route ${route}` }) }
    } catch (error) {
      return toResult(error)
    }
  }
}
