/**
 * Host half of the plugin.
 *
 * The browser half is a right-sidebar tab that renders a **pre-built view** of
 * the version store: `<workspace>/.dsh/versions-view.json`. That file is written
 * by `@voltarenyah/dsh-engineering-context` after every commit, replay and
 * annotation, so this plugin never reads SQLite itself and never needs the
 * store's schema.
 *
 * This half exists so the Loader has a row to scan: client-modules only asks
 * for `lib/client.js` when an enabled entry declares the package (see
 * `cordis.patch.yml`). It owns no resource and does no work.
 *
 * @module dsh-ui-versions
 */

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-versions'

/** The slice of the host context this half touches. */
export interface HostContext {
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}

/**
 * Announce the browser half; the version data is produced elsewhere.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.logger?.info?.(
    'ui-versions: right-sidebar tab registered; reads <workspace>/.dsh/versions-view.json ' +
      '(written by @voltarenyah/dsh-engineering-context)',
  )
}
