/**
 * The status route: `GET /changes/api/status?session=<sessionId>`.
 *
 * This is the plugin's only client↔host channel. It exists because the browser
 * cannot run `git`, and because the panel must show the working tree **as it is
 * now**, not a file some earlier step happened to write.
 *
 * What it returns is deliberately narrow: repository identity plus, per file,
 * the porcelain status letters and the `+N/−M` line counts. **No file content
 * and no diff hunks cross this route** — the panel's whole job is to say what is
 * dirty, and a "what changed" view is out of scope for v1.
 *
 * Security posture (same shape as `dsh-ui-prompt-guide` and
 * `dsh-ui-project-dashboard`): `ctx.webServer` routes carry **no
 * authentication** — only `/api` does — so this route copies the minimal trust
 * fence: reject `Sec-Fetch-Site: cross-site`, require `Host` to be a loopback
 * name (or an explicitly trusted one), and when an `Origin` is present require
 * it to match `Host`. That blocks DNS rebinding and cross-site fetch; it is not
 * authentication, and a local process could run `git status` itself anyway.
 *
 * The request carries **no path**: only a session id, which the host resolves
 * through the session store. That is what keeps this route from being a
 * directory oracle.
 *
 * @module dsh-ui-changes/route
 */

import { StatusError } from './errors.js'
import type { StatusPayload, StatusService } from './types.js'

export type { ChangedFile, ChangesTotals, StatusPayload, StatusService } from './types.js'

/** Everything under this prefix belongs to the plugin. */
export const ROUTE_PREFIX = '/changes'

/** The single endpoint served today. */
export const STATUS_PATH = '/changes/api/status'

/** Just enough of Node's `IncomingMessage` for this route. */
export interface RequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

/** Just enough of Node's `ServerResponse` for this route. */
export interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string | Uint8Array): unknown
}

/** One response, independent of Node's `http` types so tests can call it. */
export interface RouteResult {
  status: number
  headers: Record<string, string>
  body?: string
}

/** Hostnames that may reach this route without extra configuration. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * The DNS-rebinding / cross-site half of the fence.
 *
 * @param headers - request headers.
 * @param trustedHosts - extra hostnames a deployment allows (remote Web).
 * @returns a refusal reason, or `null` when the request may proceed.
 */
export function fenceFailure(headers: RequestLike['headers'], trustedHosts: readonly string[] = []): string | null {
  if (header(headers, 'sec-fetch-site') === 'cross-site') return 'cross-site request refused'
  const host = header(headers, 'host')
  if (host === null) return 'missing host'
  const hostname = hostnameOf(host)
  if (hostname === null) return 'malformed host'
  if (!LOOPBACK.has(hostname) && !trustedHosts.includes(hostname)) return `host ${hostname} is not trusted`
  const origin = header(headers, 'origin')
  if (origin === null) return null
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return 'origin is not a URL'
  }
  return originHost === host ? null : 'origin does not match host'
}

/**
 * Answer one request.
 *
 * Method, fence, path and parameter checks all live here, so this function is
 * the whole route apart from writing the response onto the socket.
 *
 * @param service - the status provider.
 * @param request - method, URL, and headers.
 * @param trustedHosts - extra hostnames the fence accepts.
 * @returns the response to write.
 */
export async function answer(
  service: StatusService,
  request: RequestLike,
  trustedHosts: readonly string[] = [],
): Promise<RouteResult> {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, { ok: false, code: 'changes/method-not-allowed', message: 'use GET or HEAD' }, { allow: 'GET, HEAD' })
  }
  const refused = fenceFailure(request.headers, trustedHosts)
  if (refused !== null) return json(403, { ok: false, code: 'changes/refused', message: refused })

  const path = pathnameOf(request)
  if (path !== STATUS_PATH) {
    return json(404, { ok: false, code: 'changes/route-not-found', message: 'not found' })
  }
  const sessionId = queryOf(request).get('session') ?? ''
  if (sessionId.length === 0) {
    return json(400, { ok: false, code: 'changes/bad-request', message: 'the session parameter is required' })
  }

  let payload: StatusPayload
  try {
    payload = await service.status(sessionId)
  } catch (error) {
    if (error instanceof StatusError) {
      return json(error.status, { ok: false, code: error.code, message: error.message })
    }
    return json(500, {
      ok: false,
      code: 'changes/status-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const result = json(200, payload)
  return method === 'HEAD' ? { status: result.status, headers: result.headers } : result
}

/**
 * Build the `webServer.register` handler.
 *
 * Turns an unexpected rejection into a logged 500 instead of an unhandled one,
 * so one bad request can never take the route down.
 *
 * @param service - the status provider.
 * @param logger - optional host logger.
 * @param trustedHosts - extra hostnames the fence accepts.
 * @returns the handler for `{ kind: 'prefix', path: ROUTE_PREFIX }`.
 */
export function createHandler(
  service: StatusService,
  logger?: { warn?(message: string): void },
  trustedHosts: readonly string[] = [],
): (request: RequestLike, response: ResponseLike) => Promise<void> {
  return async (request, response) => {
    let result: RouteResult
    try {
      result = await answer(service, request, trustedHosts)
    } catch (error) {
      logger?.warn?.(`ui-changes: ${STATUS_PATH} failed: ${String(error)}`)
      result = json(500, { ok: false, code: 'changes/internal', message: 'status route failed' })
    }
    response.writeHead(result.status, result.headers)
    response.end(result.body)
  }
}

/**
 * Write one result.
 *
 * @param status - HTTP status.
 * @param value - JSON-serialisable body.
 * @param extra - additional headers.
 * @returns the response.
 */
function json(status: number, value: unknown, extra: Record<string, string> = {}): RouteResult {
  const body = JSON.stringify(value)
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
    body,
  }
}

/** @returns one header value, or null. */
function header(headers: RequestLike['headers'], name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value.join(', ')
  return null
}

/** @returns the hostname part of a `Host` header, or null. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/** @returns the decoded pathname, or `/` when the URL cannot be parsed. */
function pathnameOf(request: RequestLike): string {
  try {
    return decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    return '/'
  }
}

/** @returns the query parameters of the request URL. */
function queryOf(request: RequestLike): URLSearchParams {
  try {
    return new URL(request.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}
