/**
 * Mount the panel API on the DSH web server (TECH §11.1).
 *
 * This is the only file that knows about HTTP. It translates a Node request into the plain shape the
 * handlers take and a result back into a response, so the interesting behaviour stays testable
 * without a socket.
 *
 * One prefix route serves every API path: the server matches `/job-ledger/api/**`, and the handlers
 * do the rest. That keeps route knowledge in one contract instead of two.
 *
 * @module dsh-job-ledger/api/mount
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { PluginError } from '../shared/errors.ts'
import { API_PREFIX } from './handlers.ts'
import type { ApiHandlers, RouteRequest } from './handlers.ts'

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/** The slice of `ctx.webServer` this module uses; kept structural so tests can fake it. */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Read and parse a JSON body.
 *
 * @param req incoming request
 * @returns the parsed value, or undefined for an empty body
 * @throws PluginError `E_INVALID_ARGUMENT` when the body is too large or not JSON
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new PluginError('E_INVALID_ARGUMENT', { what: 'request body is too large' })
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new PluginError('E_INVALID_ARGUMENT', { what: 'request body is not JSON' })
  }
}

/**
 * Normalize request headers to the string-or-undefined shape the handlers expect.
 *
 * @param req incoming request @returns header map
 */
function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = Array.isArray(value) ? value[0] : value
  }
  return headers
}

/**
 * Turn a Node request into the handler shape.
 *
 * @param req incoming request
 * @param body already-parsed body
 * @returns the route request
 */
export function routeRequestFrom(req: IncomingMessage, body: unknown): RouteRequest {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.startsWith(API_PREFIX)
    ? url.pathname.slice(API_PREFIX.length)
    : url.pathname.replace(/^\/+/, '')

  const query: Record<string, string | undefined> = {}
  for (const [key, value] of url.searchParams.entries()) query[key] = value

  return {
    method: req.method === 'POST' ? 'POST' : 'GET',
    path,
    query,
    body,
    headers: headersOf(req),
  }
}

/**
 * Handle one HTTP request end to end.
 *
 * @param req incoming request
 * @param res response owned by this handler
 * @param api dispatcher
 */
export async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  api: ApiHandlers,
): Promise<void> {
  let result
  try {
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined
    result = await api(routeRequestFrom(req, body))
  } catch (error) {
    const code = error instanceof PluginError ? error.code : 'E_BODY_UNAVAILABLE'
    result = {
      status: 400,
      body: {
        error: error instanceof Error ? error.message : 'bad request',
        code,
      },
    }
  }

  res.statusCode = result.status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(result.body))
}

/**
 * Register the API on a web server.
 *
 * @param server the host's web server
 * @param api dispatcher from {@link createApi}
 * @returns the disposer that unregisters the route
 */
export function mountApi(server: WebServerLike, api: ApiHandlers): () => void {
  return server.register({
    kind: 'prefix',
    path: API_PREFIX.replace(/\/$/, ''),
    handler: (req, res) => handleHttp(req, res, api),
  })
}
