/**
 * dsh-engineering-graph — engineering knowledge graph for DeepSeek Harness
 * (plugin family 3).
 *
 * The plugin is the TypeScript half of a two-part design:
 *
 *   DSH host process                    engine subprocess (C#, .NET, x64)
 *   ─────────────────                   ──────────────────────────────────────
 *   tools: (not yet)                    the graph queries themselves: block
 *   lifecycle: ctx.effect owns the      logic, cross-references, artefacts —
 *              child process             one structured JSON protocol
 *   config: enginePath / timeouts       logs nothing the plugin does not ask for
 *
 * This file is deliberately small: it resolves the configuration, resolves the
 * engine path and takes ownership of the seam the engine subprocess will be
 * attached to. It **registers no tools yet** and **starts no process** — that is
 * the next step, once the vendored engine and the tool surface exist.
 *
 * A missing engine is never a load failure. `apply` warns with the path, where
 * that path came from (`config` or `package`) and how to build the engine, then
 * continues: the plugin must load on a machine that has never built the C# half,
 * exactly like family 1 loads without TIA Portal installed.
 *
 * @module dsh-engineering-graph
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ENGINE_RELATIVE_PATH, resolveEnginePath } from './engine-path.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'engineering-graph'

/**
 * The plugin will register tools, so the tool registry must exist before `apply`
 * runs. Declaring it here makes the loader wait for it instead of failing — and
 * it keeps the dependency list correct for the step that adds the tools.
 */
export const inject = ['tools']

export { Config }

/**
 * Resolve the configuration and the engine, report what was found, and register
 * the disposer that will own the engine subprocess.
 *
 * Never throws when the engine executable is missing (see the module comment).
 *
 * @param ctx - the plugin context; `ctx.effect` will own the engine subprocess.
 * @param config - the validated profile config, or undefined when the profile
 *   inserts the bundle without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log = ctx.logger(name)
  const { path: enginePath, source } = resolveEnginePath(settings.enginePath)

  if (existsSync(enginePath)) {
    log.info(`engineering-graph engine: ${enginePath} (resolved from ${source}). No tools are registered yet.`)
  } else {
    // Deliberately a warning, not a throw: the engine is built separately from
    // this package (it needs the .NET SDK), so requiring it here would make the
    // bundle unloadable on a checkout that has not built it. The step that
    // registers the engine-backed tools is the one that must report the failure
    // per call, with the structured reason.
    log.warn(
      `The engineering-graph engine was not found at ${enginePath} (resolved from ${source}). ` +
        `The plugin still loads and registers no engine-backed tools yet, but they will need it: build it with ` +
        `"dotnet build engine/EngineeringGraph.Engine.csproj -c Release" (the default output is ` +
        `${ENGINE_RELATIVE_PATH}, Windows x64), or point the plugin's enginePath config at an existing executable.`,
    )
  }

  // The seam the engine subprocess will be attached to. It owns nothing yet: the
  // process is started in the step that adds the tools, and this is where its
  // ControllerProcess-style owner will be constructed. Registering it now means
  // the ownership path is exercised from the first commit — a plugin that starts
  // a process without a disposer here would leave it running on unload, which is
  // the incident family 1's effect exists to prevent. The disposer is async and
  // awaited by the framework, so unloading never returns before the child is gone.
  ctx.effect(() => {
    return async (): Promise<void> => {
      // Nothing to release yet. When the engine process lands, stop it here.
    }
  }, `${name}: engine process`)
}

/** Exposed for the tests. */
export { resolveConfig, resolveEnginePath, ENGINE_RELATIVE_PATH }
export { bundledEnginePath } from './engine-path.js'
export type { EnginePathSource } from './engine-path.js'
export type { PluginConfig }
