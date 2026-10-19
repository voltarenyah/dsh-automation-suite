/**
 * TIAOpennessV17Min — PLC block access and project/PLC/F-data access for TIA
 * Portal V17 through Openness.
 *
 * The package ships **two Loader rows**, because DSH resolves tool visibility
 * per declaration scope:
 *
 *   the host row (this module, package `"."`) — composition-wide, agent-independent
 *   ────────────────────────────────────────────────────────────────────────────
 *   controller: ctx.effect owns the C# subprocess (spawned on demand, one
 *               exclusive-access transaction per write, structured JSON)
 *   services:   `engineeringAccess` — the public seam for other plugins
 *               (`access.ts`, and the distribution's D12);
 *               `tiaOpennessRuntime` — this row's internal seam for its own
 *               tools row (`runtime-service.ts`), not a public interface
 *   knowledge:  the vendored Openness skill set, served as one bundled skill
 *               (see `skills.ts`); registered only when the composition has a
 *               skill registry, so its absence never blocks anything
 *
 *   the tools row (`tools-entry.ts`, package `"./tools"`) — declared per preset
 *   ────────────────────────────────────────────────────────────────────────────
 *   26 model-facing tools over 25 whitelisted operations (project data, PLC
 *   data, F-related, block read/write, controller_status), registered by
 *   `tools.ts` against the host row's runtime seam
 *
 * Why the split: one row would register the tools in the host (global) plane, so
 * every agent — delegated subagents included — would inherit them. The leader
 * preset declares the `/tools` row and keeps all 26; the expert subagent preset
 * does not, and sees no TIA tool. Both presets still share the one controller
 * subprocess and the `engineeringAccess` service the host row owns.
 *
 * The operation surface and its parameters are frozen in
 * `docs/EXTENDED-SURFACE.md`. The controller is spawned on demand, serializes
 * operations because Openness is not thread safe, and is terminated by the
 * effect disposer when the host row unloads — so unloading never leaves the
 * subprocess behind.
 *
 * @module dsh-tia-openness-v17-min
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ControllerProcess, resolveControllerPath, type LogSink } from './controller.js'
import { EngineeringAccess, ENGINEERING_ACCESS_SERVICE } from './access.js'
import { TiaOpennessRuntime, TIA_RUNTIME_SERVICE } from './runtime-service.js'
import { registerSkillProvider } from './skills.js'
import type { ToolDependencies } from './tools.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'tia-openness-v17-min'

/**
 * The host row needs no service before `apply` runs.
 *
 * It used to declare `['tools']` because it registered the tools itself. Those
 * now live in the `/tools` row (`tools-entry.ts`), which is where
 * `inject: ['tools', 'tiaOpennessRuntime']` belongs. What this row still needs
 * is the optional skill registry, and that is deliberately requested through
 * `ctx.inject(['skills'], …)` inside `apply` rather than here: a profile without
 * `@deepseek-ai/dsh-skill` must still load the controller and the services. An
 * empty list therefore states the truth — the host row waits for nothing.
 */
export const inject: readonly string[] = []

export { Config }

/**
 * Takes ownership of the controller subprocess and publishes the two seams
 * other rows read: `engineeringAccess` for other plugins and
 * `tiaOpennessRuntime` for this package's own `/tools` row.
 *
 * No tool is registered here; the model-facing surface is the separate
 * `tools-entry.ts` row, so an agent preset can decide whether to declare it.
 *
 * @param ctx - the plugin context; `ctx.effect` owns the subprocess.
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

  // The seam this package's own `/tools` row reads back. It is internal on
  // purpose: constructing it registers a service, but no tool, so the host row
  // stays tool-free. See `runtime-service.ts`.
  new TiaOpennessRuntime(ctx, dependencies)

  // The seam the engineering-context plugin consumes: fingerprints and
  // exports can only be obtained with a project open, and this is the plugin
  // allowed to talk to TIA Portal. Constructing the service registers it on this
  // context and ties it to this plugin's fiber, so unloading the host row
  // removes the service again. See `access.ts` and docs/decisions.md D12.
  const access = new EngineeringAccess(ctx, dependencies)

  // The knowledge base is optional by design: `ctx.inject` only starts this
  // child plugin once the skill registry exists, so a profile without
  // `@deepseek-ai/dsh-skill` never blocks on a service that is not there. The
  // skills belong to the host row, not the tools row: they are composition-wide
  // knowledge, not a model-facing tool surface. See `skills.ts`.
  registerSkillProvider(ctx, log)

  let startup: Promise<boolean> | null = null
  const exposed =
    `exposing the ${access.name} service (${ENGINEERING_ACCESS_SERVICE}) and the ${TIA_RUNTIME_SERVICE} seam ` +
    `for the /tools row`
  if (exePath.length === 0 || !existsSync(exePath)) {
    log.warn(
      `The TIA Openness controller was not found at ${exePath} (resolved from ${source}). The host row is loaded ` +
        `(${exposed}), but the /tools row will fail every call with controller_not_found until it is built with ` +
        '"npm run build:controller" or controllerPath points at the executable. TIA Portal V17 and Windows x64 are required.',
    )
  } else {
    log.info(
      `Loaded the TIA Portal V17 host row (${exposed}); the model-facing tools are registered by the separate ` +
        `/tools row; controller: ${exePath}`,
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
