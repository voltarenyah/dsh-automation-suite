/**
 * TIAOpennessV17Min — PLC block access and project/PLC/F-data access for TIA
 * Portal V17 through Openness.
 *
 * The plugin is the TypeScript half of a two-part design:
 *
 *   DSH host process                       controller subprocess (C#, x64, net48)
 *   ─────────────────                      ──────────────────────────────────────
 *   tools: 26 tools over 25 whitelisted    the same 25 operations, one
 *          operations (project data,       exclusive-access transaction per
 *          PLC data, F-related, block      write, read-back verification after
 *          read/write, controller_status)  every write, structured JSON results
 *   lifecycle: ctx.effect owns the child    structured JSON results
 *   knowledge: the vendored Openness skill set, served as one bundled skill
 *              (see `skills.ts`); registered only when the composition has a
 *              skill registry, so its absence never blocks the tools
 *
 * The operation surface and its parameters are frozen in
 * `docs/EXTENDED-SURFACE.md`.
 *
 * The controller is spawned on demand, serializes operations because Openness is
 * not thread safe, and is terminated by the effect disposer when the plugin
 * unloads — so unloading never leaves the subprocess behind.
 *
 * @module dsh-tia-openness-v17-min
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ControllerProcess, resolveControllerPath, type LogSink } from './controller.js'
import { EngineeringAccess, ENGINEERING_ACCESS_SERVICE } from './access.js'
import { registerSkillProvider } from './skills.js'
import { registerTools, type ToolDependencies } from './tools.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'tia-openness-v17-min'

/**
 * The plugin registers tools, so the tool registry must exist before `apply`
 * runs. Declaring it here makes the loader wait for it instead of failing.
 */
export const inject = ['tools']

export { Config }

/**
 * Registers the TIA Portal V17 tools and takes ownership of the controller
 * subprocess.
 *
 * @param ctx - the plugin context; `ctx.tools` registers the tools and
 *   `ctx.effect` owns the subprocess.
 * @param config - the validated profile config, or undefined when the profile
 *   inserts the bundle without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log: LogSink = ctx.logger(name)
  const { path: exePath, source } = resolveControllerPath(settings.controllerPath)

  const controller = new ControllerProcess({
    exePath: settings.controllerPath,
    opennessDir: settings.opennessDir,
    requestTimeoutMs: settings.requestTimeoutMs,
    startupTimeoutMs: settings.startupTimeoutMs,
    shutdownGraceMs: settings.shutdownGraceMs,
    maxQueue: settings.maxQueue,
    logControllerOutput: settings.logControllerOutput,
    log,
  })

  const dependencies: ToolDependencies = {
    request: async (operation, params, options) => await controller.request(operation, params, options),
    status: () => controller.status(),
    verbose: settings.verboseResults,
    log,
  }

  const registered = registerTools(ctx, dependencies)

  // The seam the engineering-context plugin consumes: fingerprints and
  // exports can only be obtained with a project open, and this is the plugin
  // allowed to talk to TIA Portal. Constructing the service registers it on this
  // context and ties it to this plugin's fiber, so unloading this plugin removes
  // the service again. See `access.ts` and docs/decisions.md D12.
  const access = new EngineeringAccess(ctx, dependencies)

  // The knowledge base is optional by design: `ctx.inject` only starts this
  // child plugin once the skill registry exists, so a profile without
  // `@deepseek-ai/dsh-skill` keeps the six tools and never blocks on a service
  // that is not there. See `skills.ts`.
  registerSkillProvider(ctx, log)

  let startup: Promise<boolean> | null = null
  const exposed = `exposing the ${access.name} service (${ENGINEERING_ACCESS_SERVICE}) for the engineering-context plugin`
  if (exePath.length === 0 || !existsSync(exePath)) {
    log.warn(
      `The TIA Openness controller was not found at ${exePath} (resolved from ${source}). The tools are registered ` +
        `(${exposed}) but every call will fail with controller_not_found until it is built with ` +
        '"npm run build:controller" or controllerPath points at the executable. TIA Portal V17 and Windows x64 are required.',
    )
  } else {
    log.info(
      `Registered ${registered.length} TIA Portal V17 tools (${registered.join(', ')}), ${exposed}; controller: ${exePath}`,
    )
    // Pay the process start and Openness probe cost now, but keep a failure here
    // non-fatal: the plugin must still load on a machine without TIA Portal, and
    // the tools report the structured reason instead.
    startup = controller.prewarm()
  }

  // The subprocess is the one resource the framework cannot own. Registering it
  // as an effect guarantees that unloading the plugin (or shutting the host down)
  // stops the controller and with it the TIA Portal session it opened. The
  // disposer is async and awaited by the framework, so unloading does not return
  // before the child process is gone.
  ctx.effect(() => {
    return async (): Promise<void> => {
      try {
        // Waiting for an in-flight start is what makes unloading deterministic:
        // otherwise the disposer could run before the child process exists.
        if (startup !== null) await startup
        await controller.stop()
        log.info('The TIA Openness controller subprocess was stopped.')
      } catch (error) {
        log.warn(`Stopping the TIA Openness controller failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, `${name}: controller process`)
}

/** Exposed for the tests. */
export { ControllerProcess, resolveControllerPath, resolveConfig }
export type { PluginConfig }
