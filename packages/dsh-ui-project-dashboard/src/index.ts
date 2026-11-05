/**
 * The host half: a Loader row and nothing else.
 *
 * Everything this plugin renders lives in the browser half (`lib/client.js`):
 * one row in the main sidebar's global panel list (`sidebar.panellist`, at
 * `order: -10` so it sits above Plugins) and one root `main` page keyed
 * `project-dashboard`. The row registered below only exists because
 * `client-modules` discovers browser bundles by scanning **enabled Loader
 * entries** — without it the bundle is never requested and nothing reports an
 * error (see `docs/ui-plugins.md` §9.1 in the distribution repository).
 *
 * @module dsh-ui-project-dashboard
 */

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'project-dashboard'

/** The slice of the host context this half touches. */
export interface HostContext {
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}

/**
 * Announce the browser half. This half owns no resource and starts no work on
 * its own: the panel reads workspace/session data through the browser's
 * standard hooks and the existing `workspaceFiles` remote.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.logger?.info?.(
    'ui-project-dashboard: global panel "project-dashboard" is provided by the browser half ' +
      '(sidebar.panellist order -10 + root main)',
  )
}
