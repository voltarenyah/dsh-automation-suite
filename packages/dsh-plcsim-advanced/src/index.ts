/**
 * PLCSIM Advanced — simulation runtime access for the automation suite.
 *
 * The package ships **two Loader rows**:
 *
 *   host row (this module, package ".") — composition-wide
 *     one C# controller subprocess (`PlcsimAdvanced.Controller.exe`), the
 *     `plcsimRuntime` seam for its own `/tools` row, and no model-facing tool
 *   `/tools` row (`tools-entry.ts`, package "./tools") — declared per preset
 *     simulation_status / simulation_instance / simulation_run / simulation_tags
 *
 * The host row is intentionally tool-free: a tool registered here would be in
 * the global scope and every delegated subagent would inherit it. The leader
 * preset declares the `/tools` row; expert/auditor do not, so they cannot
 * change a running simulation.
 *
 * Program loading is not part of this row. TIA V17 Openness has no PLCSIM
 * download API (docs/simulation-plcsim-advanced.md §10), so the runtime MVP
 * works with an instance that already contains a program. The program-load
 * decision (TIA V20 vs. a one-time manual download) is tracked separately.
 *
 * @module dsh-plcsim-advanced
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ControllerProcess, resolveControllerPath, type LogSink } from './controller.js'
import { PlcsimRuntime } from './runtime-service.js'
import type { ToolDependencies } from './tools.js'

export const name = 'plcsim-advanced'

export const inject: readonly string[] = []

export { Config }

export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log: LogSink = ctx.logger(name)
  const resolved = resolveControllerPath(settings.controllerPath)

  const controller = new ControllerProcess({
    exePath: resolved.path,
    apiDir: settings.apiDir,
    storageRoot: settings.storageRoot,
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

  new PlcsimRuntime(ctx, dependencies)

  ctx.effect(() => {
    log.info(`PLCSIM controller: ${resolved.path} (${resolved.source}); api dir ${settings.apiDir}.`)
    return async () => {
      await controller.dispose()
    }
  })
}
