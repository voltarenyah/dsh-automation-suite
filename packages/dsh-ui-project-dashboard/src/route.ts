/**
 * The tags HTTP route: `GET|POST /project-dashboard/api/tags`.
 *
 * This is the only client↔host channel the dashboard needs, and it exists only
 * because the browser cannot write a host file. Reads happen once when the page
 * opens; writes happen only when the user adds or removes a tag. There is no
 * polling and no per-workspace host work — the rule set on 2026-11-05.
 *
 * Security posture (same shape as `dsh-ui-prompt-guide`, plus a Host check):
 * `ctx.webServer` routes carry **no authentication** — only `/api` does — so
 * this route copies the minimal trust fence: reject `Sec-Fetch-Site: cross-site`,
 * require the `Host` to be a loopback name (or an explicitly trusted one), and
 * when an `Origin` is present require it to match `Host`. That blocks DNS
 * rebinding and cross-site fetch; it is not authentication, and a local process
 * could read the file directly anyway. The request carries no paths — only a
 * workspace id and tag strings — so there is nothing to traverse.
 *
 * @module dsh-ui-project-dashboard/route
 */

import { TagConflictError, TagInputError, type TagDocument, type TagEntry, type TagOperation } from './tags/model.js'
import type { TagSnapshot } from './tags/store.js'

/** Everything under this prefix belongs to the plugin. */
export const ROUTE_PREFIX = '/project-dashboard'

/** The one endpoint. */
export const ROUTE_PATH = '/project-dashboard/api/tags'

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024

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

/** The store surface the route needs. */
export interface TagsService {
  snapshot(): Promise<TagSnapshot>
  mutate(operation: TagOperation, path: string, expectedRevision?: number): Promise<{ doc: TagDocument; entry: TagEntry }>
  /** Canonical directory for one workspace id, or `''` when the registry lacks it. */
  resolvePath(workspaceId: string): string
}

/** One response, independent of Node's `http` types so tests can call it. */
export interface RouteResult {
  status: number
  headers: Record<string, string>
  body: string
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
 * Answer one validated request.
 *
 * Method and path are checked here too, so this function is the whole route
 * except for reading the request body off the socket.
 *
 * @param service - the tag store plus path lookup.
 * @param request - method, URL, and headers.
 * @param bodyText - already-read body (POST only).
 * @param trustedHosts - extra hostnames the fence accepts.
 * @returns the response to write.
 */
export async function handleRequest(
  service: TagsService,
  request: RequestLike,
  bodyText = '',
  trustedHosts: readonly string[] = [],
): Promise<RouteResult> {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { ok: false, code: 'method/not-allowed', message: 'use GET or POST' }, { allow: 'GET, POST' })
  }
  const refused = fenceFailure(request.headers, trustedHosts)
  if (refused !== null) return json(403, { ok: false, code: 'request/refused', message: refused })
  if (pathnameOf(request) !== ROUTE_PATH) return json(404, { ok: false, code: 'route/not-found', message: 'not found' })

  if (method === 'GET') {
    const snapshot = await service.snapshot()
    return json(200, {
      ok: true,
      revision: snapshot.doc.revision,
      corrupt: snapshot.corrupt,
      workspaces: snapshot.doc.workspaces,
    })
  }

  return mutate(service, bodyText)
}

/**
 * Apply one POST body.
 *
 * @param service - the store.
 * @param bodyText - raw JSON text.
 * @returns the response.
 */
async function mutate(service: TagsService, bodyText: string): Promise<RouteResult> {
  let input: unknown
  try {
    input = JSON.parse(bodyText)
  } catch {
    return json(400, { ok: false, code: 'body/not-json', message: 'body must be JSON' })
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return json(400, { ok: false, code: 'body/not-object', message: 'body must be a JSON object' })
  }
  const body = input as Record<string, unknown>
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  if (workspaceId.length === 0) return json(400, { ok: false, code: 'workspace/missing-id', message: 'workspaceId is required' })

  const op = body.op
  let operation: TagOperation
  if (op === 'add' || op === 'remove') {
    if (typeof body.tag !== 'string') return json(400, { ok: false, code: 'tag/not-string', message: 'tag must be a string' })
    operation = { op, workspaceId, tag: body.tag }
  } else if (op === 'set') {
    if (!Array.isArray(body.tags)) return json(400, { ok: false, code: 'tags/not-array', message: 'tags must be an array' })
    operation = { op: 'set', workspaceId, tags: body.tags as string[] }
  } else {
    return json(400, { ok: false, code: 'op/unknown', message: 'op must be add, remove or set' })
  }

  const expectedRevision =
    typeof body.expectedRevision === 'number' && Number.isFinite(body.expectedRevision)
      ? Math.floor(body.expectedRevision)
      : undefined

  try {
    const path = service.resolvePath(workspaceId)
    const result = await service.mutate(operation, path, expectedRevision)
    return json(200, {
      ok: true,
      revision: result.doc.revision,
      entry: result.entry,
      workspaces: result.doc.workspaces,
    })
  } catch (error) {
    if (error instanceof TagInputError) return json(400, { ok: false, code: error.code, message: error.message })
    if (error instanceof TagConflictError) {
      return json(409, { ok: false, code: 'tags/conflict', message: error.message, revision: error.current })
    }
    throw error
  }
}

/**
 * Build the `webServer.register` handler.
 *
 * Reads the body only after the fence passed, caps it, and turns unexpected
 * failures into a logged 500 instead of an unhandled rejection.
 *
 * @param service - the store plus path lookup.
 * @param logger - optional host logger.
 * @param trustedHosts - extra hostnames the fence accepts.
 * @returns the handler for `{ kind: 'prefix', path: ROUTE_PREFIX }`.
 */
export function createHandler(
  service: TagsService,
  logger?: { warn?(message: string): void },
  trustedHosts: readonly string[] = [],
): (request: RequestLike, response: ResponseLike) => Promise<void> {
  return async (request, response) => {
    let result: RouteResult
    try {
      const method = (request.method ?? 'GET').toUpperCase()
      let bodyText = ''
      if (method === 'POST') {
        const read = await readBody(request, MAX_BODY_BYTES)
        if (read.tooLarge) {
          result = json(413, { ok: false, code: 'body/too-large', message: `body may be at most ${MAX_BODY_BYTES} bytes` })
          write(response, result)
          return
        }
        bodyText = read.text
      }
      result = await handleRequest(service, request, bodyText, trustedHosts)
    } catch (error) {
      logger?.warn?.(`ui-project-dashboard: /api/tags failed: ${String(error)}`)
      result = json(500, { ok: false, code: 'store/io', message: 'tag storage failed' })
    }
    write(response, result)
  }
}

/**
 * Read a request body up to a byte cap.
 *
 * @param request - the incoming request.
 * @param limit - largest accepted body.
 * @returns the body text and whether the cap was exceeded.
 */
async function readBody(request: RequestLike, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  const stream = request as unknown as AsyncIterable<Uint8Array | string>
  if (typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    return { text: '', tooLarge: false }
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    size += bytes.byteLength
    if (size > limit) return { text: '', tooLarge: true }
    chunks.push(bytes)
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const bytes of chunks) {
    merged.set(bytes, offset)
    offset += bytes.byteLength
  }
  return { text: new TextDecoder('utf-8').decode(merged), tooLarge: false }
}

/**
 * Write one result.
 *
 * @param response - the host response.
 * @param result - status, headers, body.
 */
function write(response: ResponseLike, result: RouteResult): void {
  response.writeHead(result.status, result.headers)
  response.end(result.body)
}

/**
 * Build a JSON response.
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
      'content-length': String(Buffer.byteLength(body)),
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
