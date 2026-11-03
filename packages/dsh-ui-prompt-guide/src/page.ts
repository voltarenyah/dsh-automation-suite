/**
 * The static page half: path resolution, MIME types, the trust fence and the
 * pure `answer()` function the web-server handler delegates to.
 *
 * The page is a **plain static site** (`page/index.html`, `app.js`, `style.css`)
 * served from the plugin package itself. It is deliberately not a client
 * bundle: the guide is documentation, and editing a sentence must not require
 * rebuilding `lib/client.js`. The only dynamic endpoint is `/api/guide`, which
 * serialises `guide.ts`.
 *
 * Security posture, stated once so nobody has to infer it:
 *
 *  - the route is registered by the host web server and — unlike `/api` — carries
 *    **no authentication** (docs/ui-plugins.md §7.5). This page therefore serves
 *    **no user data**: only the guide text that ships inside the package. There is
 *    nothing to leak that is not already in the distribution.
 *  - what remains is the DNS-rebinding / cross-site shape, so the fence refuses
 *    `Sec-Fetch-Site: cross-site` and any `Origin` whose host does not match the
 *    request's `Host`. That is not authentication; it is the same minimal guard
 *    the guide's §7.5 asks a plugin to copy.
 *  - files are resolved inside one root and re-checked through `realpath`, so
 *    `..`, dotfiles and symlinks that point outside the page directory are
 *    refused rather than served.
 *
 * @module dsh-ui-prompt-guide/page
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Mount point of the page and of its JSON endpoint. */
export const ROUTE_BASE = '/prompt-guide'

/** Directory the page is served from (the package's `page/`, next to `lib/`). */
export const PAGE_ROOT = fileURLToPath(new URL('../page', import.meta.url))

/** Extensions the page is allowed to serve. Anything else is a 404, not a download. */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** One response, independent of Node's `http` types so tests can call it. */
export interface PageResponse {
  status: number
  headers: Record<string, string>
  body?: string | Buffer
}

/** Headers a handler may present; `http.IncomingHttpHeaders` fits this shape. */
export type RequestHeaders = Record<string, string | string[] | undefined>

/** Just enough of Node's `IncomingMessage` for the page route. */
export interface PageRequest {
  method?: string
  url?: string
  headers: RequestHeaders
}

/**
 * Content type for one file, by extension.
 *
 * @param file - file name or path.
 * @returns the MIME type, or `application/octet-stream` for unknown extensions.
 */
export function contentTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a request path to a file inside `root`, or `null` when it must not be
 * served.
 *
 * Only allow-listed extensions are served, no segment may start with a dot, and
 * the resolved real path must still be below the real root (the `realpath` step
 * catches a symlink pointing out of the directory).
 *
 * @param root - page directory (absolute).
 * @param rel - path relative to `root`, forward slashes.
 * @returns the absolute file path, or `null`.
 */
export function safePageFile(root: string, rel: string): string | null {
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

/**
 * The DNS-rebinding / cross-site half of the fence.
 *
 * @param headers - request headers.
 * @returns a refusal reason, or `null` when the request may proceed.
 */
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

/**
 * Read one header, lower-cased and collapsed to a single string.
 *
 * @param headers - request headers.
 * @param name - header name.
 * @returns the value, or `null`.
 */
function header(headers: RequestHeaders, name: string): string | null {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value.join(', ')
  return null
}

/**
 * Answer one request against the page directory.
 *
 * Pure apart from reading the file system, so the handler in `index.ts` is a
 * two-line adapter and the tests drive this directly.
 *
 * @param root - page directory (absolute).
 * @param pathname - decoded request path starting with {@link ROUTE_BASE}.
 * @param method - HTTP method.
 * @param headers - request headers.
 * @param guideJson - serialised guide document, called only for `/api/guide`.
 * @returns the response to write.
 */
export function answer(
  root: string,
  pathname: string,
  method: string,
  headers: RequestHeaders,
  guideJson: () => string,
): PageResponse {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, body: 'method not allowed' }
  }
  const refused = fenceFailure(headers)
  if (refused !== null) {
    return { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: refused }
  }
  if (pathname === ROUTE_BASE) {
    return { status: 308, headers: { location: `${ROUTE_BASE}/` } }
  }
  if (!pathname.startsWith(`${ROUTE_BASE}/`)) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'not found' }
  }
  const rest = pathname.slice(ROUTE_BASE.length)
  if (rest === '/api/guide') {
    const body = guideJson()
    return {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store',
      },
      body: method === 'HEAD' ? undefined : body,
    }
  }
  const file = safePageFile(root, rest === '/' ? 'index.html' : rest.replace(/^\/+/, ''))
  if (file === null) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'not found' }
  }
  const data = readFileSync(file)
  return {
    status: 200,
    headers: {
      'content-type': contentTypeOf(file),
      'content-length': String(data.byteLength),
      'cache-control': 'no-cache',
    },
    body: method === 'HEAD' ? undefined : data,
  }
}
