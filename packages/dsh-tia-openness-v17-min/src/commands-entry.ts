/**
 * The `/commands` row: the human-facing `/tia-…` slash commands as a Loader
 * entry of their own.
 *
 * Why a third row instead of folding the commands into the host or the `/tools`
 * row:
 *
 *   - **The host row must stay human-surface-free.** A command registered there
 *     would be global, so it would appear in every agent's `/` menu — including
 *     agents whose preset deliberately does not declare the TIA tools.
 *   - **The `/tools` row is the model's surface.** It exists so a preset can
 *     decide whether an agent sees TIA tools; a command is a human action that
 *     runs without the model, so it must not disappear when that preset omits
 *     the tools row (and must not appear merely because it declares it).
 *   - **It injects only `commands` and `tiaOpennessRuntime`.** The row owns no
 *     process and no configuration: it reads the host row's controller seam,
 *     exactly like the `/tools` row does.
 *
 * Because a command row is mounted under an agent's preset, its registrations
 * are agent-scoped (`@deepseek-ai/dsh-commands`), which is what keeps the menu
 * and the tool surface consistent.
 *
 * @module dsh-tia-openness-v17-min/commands-entry
 */

import type { Context } from '@deepseek-ai/cordis'

import { registerCommands } from './commands.js'
import { TIA_RUNTIME_SERVICE, tiaOpennessRuntimeOf } from './runtime-service.js'

/**
 * Loader entry id of the commands row.
 *
 * Distinct from the host row's `tia-openness-v17-min` and the tools row's
 * `tia-openness-v17-min-tools`, so a profile can declare, disable or move it
 * independently.
 */
export const name = 'tia-openness-v17-min-commands'

/**
 * The command registry is where the commands are registered; `tiaOpennessRuntime`
 * is the host row's seam to the controller. Declaring both makes the loader
 * wait for them instead of failing, whatever the composition order.
 */
export const inject = ['commands', TIA_RUNTIME_SERVICE]

/**
 * Registers the `/tia-…` commands against the host row's runtime seam.
 *
 * @param ctx - the commands row's context; `ctx.commands` receives the defs.
 */
export function apply(ctx: Context): void {
  const runtime = tiaOpennessRuntimeOf(ctx)
  const log = ctx.logger(name)

  const registered = registerCommands(ctx, {
    request: runtime.request,
    status: runtime.status,
    verbose: runtime.verbose,
    log,
  })

  log.info(
    `Registered ${registered.length} TIA Portal slash commands (${registered.map((command) => `/${command}`).join(', ')}); ` +
      'the controller subprocess and the tiaOpennessRuntime seam are owned by the host row.',
  )
}
