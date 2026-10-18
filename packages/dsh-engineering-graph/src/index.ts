/**
 * dsh-engineering-graph — engineering knowledge graph for DeepSeek Harness
 * (engineering-graph plugin).
 *
 * The plugin is the TypeScript half of a two-part design:
 *
 *   DSH host process                    engine subprocess (C#, .NET, x64)
 *   ─────────────────                   ──────────────────────────────────────
 *   tools: knowledge_schema,            the graph itself: GetSchema (DDL, node
 *          knowledge_ingest,            kinds, edge types), Ingest (crawl a
 *          knowledge_query              device export folder into SQLite),
 *   lifecycle: ctx.effect owns the      Query (one read-only SELECT)
 *              child process             one structured JSON protocol
 *   config: enginePath / timeouts       stderr carries human notes, stdout frames
 *
 * `apply` registers the three tools and takes ownership of the engine subprocess
 * through `ctx.effect`. The engine is started lazily by the first request: `apply`
 * neither spawns nor warms it, so loading the plugin on a machine that has never
 * built the C# half stays cheap and side-effect free, and the disposer stops an
 * engine that may never have existed.
 *
 * A missing engine is never a load failure. `apply` warns with the path, where
 * that path came from (`config` or `package`) and how to build the engine, then
 * continues: the plugin must load on a machine that has never built the C# half,
 * exactly like the TIA Openness plugin loads without TIA Portal installed. The tools are
 * registered either way and fail per call with the honest transport error
 * (`engine_not_found`), which is what tells the model the difference between "the
 * engine refused this" and "there is no engine".
 *
 * @module dsh-engineering-graph
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ENGINE_RELATIVE_PATH, bundledEnginePath, resolveEnginePath } from './engine-path.js'
import { EngineClient, type LogSink } from './engine-client.js'
import { registerTools, type ToolDependencies } from './tools.js'
import { KnowledgeGraph } from './service.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'engineering-graph'

/**
 * The plugin registers tools, so the tool registry must exist before `apply`
 * runs. Declaring it here makes the loader wait for it instead of failing.
 */
export const inject = ['tools']

export { Config }

/**
 * Resolve the configuration and the engine, register the tools, and hand the
 * engine subprocess to the effect disposer.
 *
 * Never throws when the engine executable is missing (see the module comment).
 *
 * @param ctx - the plugin context; `ctx.tools` takes the tools and `ctx.effect`
 *   owns the engine subprocess.
 * @param config - the validated profile config, or undefined when the profile
 *   inserts the bundle without a config block.
 */
export function apply(ctx: Context, config?: Partial<PluginConfig>): void {
  const settings = resolveConfig(config)
  const log: LogSink = ctx.logger(name)
  const { path: enginePath, source } = resolveEnginePath(settings.enginePath)

  // The client resolves the path again on every use (status, spawn), from the same
  // configured value, so what it reports can never drift from what it runs.
  const engine = new EngineClient({
    enginePath: settings.enginePath,
    requestTimeoutMs: settings.requestTimeoutMs,
    startupTimeoutMs: settings.startupTimeoutMs,
    logEngineOutput: settings.logEngineOutput,
    log,
  })

  const dependencies: ToolDependencies = {
    request: async (operation, params, options) => await engine.request(operation, params, options),
    log,
  }

  const registered = registerTools(ctx, dependencies)

  // Constructing the service is what registers it, and the registration belongs to
  // this plugin's fiber, so it disappears when the plugin unloads (docs/decisions.md
  // D21). Nothing else needs the instance, which is why it is not stored.
  new KnowledgeGraph(ctx, dependencies, settings.enginePath)

  if (existsSync(enginePath)) {
    log.info(
      `Registered ${registered.length} engineering-graph tools (${registered.join(', ')}); engine: ${enginePath} (resolved from ${source}).`,
    )
  } else {
    // Deliberately a warning, not a throw: the engine is built separately from this
    // package (it needs the .NET SDK), so requiring it here would make the bundle
    // unloadable on a checkout that has not built it. The tools are registered
    // anyway and each call reports the structured transport failure.
    log.warn(
      `The engineering-graph engine was not found at ${enginePath} (resolved from ${source}). The tools are ` +
        `registered (${registered.join(', ')}) but every call will fail with engine_not_found until it is built: ` +
        `build it with "dotnet build engine/EngineeringGraph.Engine.csproj -c Release" (the default output is ` +
        `${ENGINE_RELATIVE_PATH}, Windows x64), or point the plugin's enginePath config at an existing executable.`,
    )
  }

  // The subprocess is the one resource the framework cannot own. Registering it as
  // an effect guarantees that unloading the plugin (or shutting the host down)
  // stops the engine. The disposer is async and awaited by the framework, so
  // unloading never returns before the child is gone, and `stop()` is safe to call
  // when no request ever started the engine — which is the common case here.
  ctx.effect(() => {
    return async (): Promise<void> => {
      const pid = engine.status().pid
      try {
        await engine.stop()
        if (pid !== null) log.info('The engineering-graph engine subprocess was stopped.')
      } catch (error) {
        log.warn(`Stopping the engineering-graph engine failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, `${name}: engine process`)
}

/** Exposed for the tests. */
export { EngineClient, resolveConfig, resolveEnginePath, bundledEnginePath, ENGINE_RELATIVE_PATH, registerTools }
export { OPERATIONS, PROTOCOL_VERSION } from './protocol.js'
export { KnowledgeGraph, KNOWLEDGE_GRAPH_SERVICE } from './service.js'
export type { PluginConfig } from './config.js'
export type { EnginePathSource } from './engine-path.js'
export type { EngineClientStatus, EngineState, LogSink, RequestOptions } from './engine-client.js'
export type { ToolDependencies } from './tools.js'
export type { EngineError, ProgressFrame, ReadyFrame, ResultFrame, ToolOutcome } from './protocol.js'
export type { IngestDeviceOptions, KnowledgeGraphStatus } from './service.js'
