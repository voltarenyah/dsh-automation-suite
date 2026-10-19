/**
 * The `/tools` row: the 26 model-facing tools as a Loader entry of their own.
 *
 * DSH resolves tool visibility per **declaration scope**. Registering the tools
 * in the same row that owns the controller would put them in the host (global)
 * plane, so every agent — delegated subagents included — would inherit them. The
 * tools therefore live behind this second entry, reachable as the package's
 * `./tools` subpath export, and each agent preset decides whether to declare it:
 * the leader preset does and keeps all 26 tools, the expert subagent preset does
 * not and sees no TIA tool at all.
 *
 * This row owns nothing durable. It reads the host row's internal
 * `tiaOpennessRuntime` seam (`runtime-service.ts`), registers `tools.ts`'s tool
 * bodies against it, and logs the names. The controller subprocess,
 * `engineeringAccess` and the bundled skill provider all stay on the host row,
 * so a composition still has exactly one `ControllerProcess` and one TIA Portal
 * session no matter how many agents declare this row.
 *
 * `inject` is what makes the ordering safe: the loader waits for both the tool
 * registry and the runtime seam before calling `apply`, so this row may be
 * declared before the host row in a composition without racing it.
 *
 * @module dsh-tia-openness-v17-min/tools-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { registerTools } from './tools.js'
import { tiaOpennessRuntimeOf, TIA_RUNTIME_SERVICE } from './runtime-service.js'

/**
 * Loader entry id of the tools row.
 *
 * Distinct from the host row's `tia-openness-v17-min`, so a profile can declare,
 * disable or move the two rows independently.
 */
export const name = 'tia-openness-v17-min-tools'

/**
 * The tool registry is where the tools are registered; `tiaOpennessRuntime` is
 * the host row's seam to the controller. Declaring both makes the loader wait
 * for them instead of failing, whatever the composition order.
 */
export const inject = ['tools', TIA_RUNTIME_SERVICE]

/**
 * Registers the 26 TIA Portal V17 tools against the host row's runtime seam.
 *
 * The tool names, their order, parameters and descriptions are exactly the ones
 * the host row used to register: `tools.ts` is unchanged and remains the single
 * implementation both rows share, so this row only decides *where* they become
 * visible.
 *
 * @param ctx - the tools row's context; `ctx.tools` receives the definitions.
 * @param _config - accepted for the loader's calling convention and ignored:
 *   every setting belongs to the host row, which the profile configures once.
 */
export function apply(ctx: Context, _config?: unknown): void {
  const runtime = tiaOpennessRuntimeOf(ctx)
  const log = ctx.logger(name)

  const registered = registerTools(ctx, {
    request: runtime.request,
    status: runtime.status,
    verbose: runtime.verbose,
    log,
  })

  log.info(
    `Registered ${registered.length} TIA Portal V17 tools (${registered.join(', ')}); ` +
      `the controller subprocess and the engineeringAccess service are owned by the host row.`,
  )
}
