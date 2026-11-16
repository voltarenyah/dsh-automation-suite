/**
 * Static files for the panel's own PDF viewer (`/drawing-viewer`).
 *
 * Why a host route: the client bundle is executed as a classic script by the
 * host's module loader and must stay free of the PDF engine, so pdf.js and the
 * small viewer page live next to `lib/` and are served as plain static assets.
 *
 * Security posture: the route serves **only code and fonts that ship inside the
 * package** — never workspace data. The PDF itself stays in the page as a
 * `blob:` URL created by the panel. The usual minimal fence is still applied
 * (same-host origin, no cross-site fetch, paths contained in one real root).
 *
 * @module dsh-drawing/viewer-route
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Mount point of the viewer assets. */
export const VIEWER_ROUTE = '/drawing-viewer'

/** Directory the viewer is served from (`lib/viewer`, next to `lib/index.js`). */
export const VIEWER_ROOT = fileURLToPath(new URL('./viewer', import.meta.url))

/** Extensions the viewer may serve. Anything else is a 404. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
}

/** One response, independent of Node's `http` types so tests can call it. */
export interface ViewerResponse {
  status: number
  headers: Record<string, string>
  body?: string | Buffer
}

/** Headers a handler may present; `http.IncomingHttpHeaders` fits this shape. */
export type RequestHeaders = Record<string, string | string[] | undefined>

/** Just enough of Node's `IncomingMessage` for the viewer route. */
export interface ViewerRequest {
  method?: string
  url?: string
  headers?: RequestHeaders
}

/** The slice of `webServer` this route needs. */
export interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (request: ViewerRequest, response: ViewerResponseLike) => void
  }): () => void
}

/** Just enough of Node's `ServerResponse`. */
export interface ViewerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string | Uint8Array): unknown
}

/** Content type for one file, by extension. */
export function contentTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a request path to a file inside `root`, or null when it must not be
 * served. Re-checks the real path so a symlink cannot escape the viewer dir.
 */
export function safeViewerFile(root: string, rel: string): string | null {
  if (rel === '' || rel.split('/').some((part) => part === '' || part.startsWith('.'))) return null
  let base: string
  try {
    base = realpathSync(root)
  } catch {
    return null
  }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  if (MIME[extname(file).toLowerCase()] === undefined) return null
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return null
  }
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

/** DNS-rebinding / cross-site fence for the static route. */
export function fenceFailure(headers: RequestHeaders): string | null {
  const site = header(headers, 'sec-fetch-site')
  if (site === 'cross-site') return 'cross-site request refused'
  const origin = header(headers, 'origin')
  if (origin === null) return null
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return 'origin is not a URL'
  }
  const host = header(headers, 'host')
  if (host === null) return 'origin without host'
  return originHost === host ? null : 'origin does not match host'
}

function header(headers: RequestHeaders, name: string): string | null {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value.join(', ')
  return null
}

/** Decode a request pathname, or null when it cannot be parsed. */
function pathnameOf(url: string | undefined): string | null {
  try {
    return decodeURIComponent(new URL(url ?? '/', 'http://localhost').pathname)
  } catch {
    return null
  }
}

/**
 * Answer one request against the viewer directory.
 *
 * @param root - viewer directory (absolute).
 * @param pathname - decoded request path starting with {@link VIEWER_ROUTE}.
 * @param method - HTTP method.
 * @param headers - request headers.
 * @returns the response to write.
 */
export function answerViewer(
  root: string,
  pathname: string,
  method: string,
  headers: RequestHeaders,
): ViewerResponse {
  const plain = { 'content-type': 'text/plain; charset=utf-8' }
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { allow: 'GET, HEAD', ...plain }, body: 'method not allowed' }
  }
  const refused = fenceFailure(headers)
  if (refused !== null) return { status: 403, headers: plain, body: refused }
  if (pathname === VIEWER_ROUTE) return { status: 308, headers: { location: `${VIEWER_ROUTE}/` } }
  if (!pathname.startsWith(`${VIEWER_ROUTE}/`)) return { status: 404, headers: plain, body: 'not found' }
  const rel = pathname.slice(VIEWER_ROUTE.length + 1)
  if (rel === '') return { status: 404, headers: plain, body: 'not found' }
  const file = safeViewerFile(root, rel)
  if (file === null) return { status: 404, headers: plain, body: 'not found' }
  const body = readFileSync(file)
  return {
    status: 200,
    headers: {
      'content-type': contentTypeOf(file),
      'content-length': String(body.byteLength),
      'cache-control': 'no-cache',
    },
    body: method === 'HEAD' ? undefined : body,
  }
}

/**
 * Register the static viewer route.
 *
 * @param webServer - host web server service.
 * @param root - viewer directory (defaults to the packaged assets).
 * @returns the disposer.
 */
export function registerViewer(webServer: WebServerLike, root = VIEWER_ROOT): () => void {
  return webServer.register({
    kind: 'prefix',
    path: VIEWER_ROUTE,
    handler: (request, response) => {
      const pathname = pathnameOf(request.url)
      if (pathname === null) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('bad request')
        return
      }
      const result = answerViewer(root, pathname, request.method ?? 'GET', request.headers ?? {})
      response.writeHead(result.status, result.headers)
      response.end(result.body)
    },
  })
}
