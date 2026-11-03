/**
 * Host half of the plugin.
 *
 * The browser half is a right-sidebar tab that renders a **pre-built view** of the
 * hardware configuration: `<workspace>/.dsh/hardware-view.json`. That file is written
 * by the TIA plugin's `hardware_view` tool (which parses the CAx/AML export), so this
 * plugin never reads XML, never runs the controller and never needs an open project.
 *
 * This half exists so the Loader has a row to scan: client-modules only asks for
 * `lib/client.js` when an enabled entry declares the package (see `cordis.patch.yml`).
 * It owns no resource and does no work.
 *
 * @module dsh-ui-hardware
 */

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-hardware'

/** The slice of the host context this half touches. */
export interface HostContext {
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}

/**
 * Announce the browser half; the hardware data is produced elsewhere.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.logger?.info?.(
    'ui-hardware: right-sidebar tab registered; reads <workspace>/.dsh/hardware-view.json ' +
      '(written by the TIA plugin\'s hardware_view tool)',
  )
}
