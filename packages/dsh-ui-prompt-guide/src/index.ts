/**
 * Host half of the plugin: serve the Prompt Guide page and its guide payload.
 *
 * The browser half (`lib/client.js`) only adds a sidebar entry and an iframe
 * pointing at `/prompt-guide/`. Everything the page shows comes from this half:
 *
 *   GET /prompt-guide/          the static page (page/index.html)
 *   GET /prompt-guide/api/guide the guide document, serialised from guide.ts
 *   GET /prompt-guide/<asset>   page assets (app.js, style.css)
 *
 * Why a route instead of a React panel: the guide is documentation, and a static
 * page can be edited (or translated) without rebuilding `lib/client.js`. The
 * trade-off is that the route carries no authentication — see the security
 * posture in `page.ts`; it serves no user data, only the text shipped in the
 * package.
 *
 * @module dsh-ui-prompt-guide
 */

import { answer, PAGE_ROOT, ROUTE_BASE, type PageRequest, type PageResponse } from './page.js'
import { guideDocument } from './guide.js'

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-prompt-guide'

/** The host services this half needs. */
export const inject = ['webServer']

/** The slice of the host context this half touches. */
export interface HostContext {
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
  webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (request: PageRequest, response: PageResponseLike) => void
    }): () => void
  }
  effect?(fn: () => (() => void) | void, label?: string): void
}

/** Just enough of Node's `ServerResponse` for this page. */
export interface PageResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string | Uint8Array): unknown
}

/** Serialised once per process; the document is static and small. */
let cachedGuideJson: string | null = null

/** @returns the JSON payload the page's `fetch('./api/guide')` receives. */
function guideJson(): string {
  if (cachedGuideJson === null) cachedGuideJson = JSON.stringify(guideDocument())
  return cachedGuideJson
}

/**
 * Register the page route.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  const register = () =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_BASE,
      handler: (request, response) => {
        const result = answer(PAGE_ROOT, pathnameOf(request), request.method ?? 'GET', request.headers, guideJson)
        response.writeHead(result.status, result.headers)
        response.end(result.body)
      },
    })

  if (typeof ctx.effect === 'function') ctx.effect(register, `${name}: page route`)
  else register()
  ctx.logger?.info?.(`${name}: Prompt Guide registered at ${ROUTE_BASE}/`)
}

/**
 * The decoded pathname, or `/` for a request whose URL cannot be parsed.
 *
 * @param request - the host's request shape.
 * @returns the path alone (no query string).
 */
function pathnameOf(request: PageRequest): string {
  try {
    return decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    return '/'
  }
}

/** Exposed for the tests: the same payload the route serves. */
export { guideDocument }
