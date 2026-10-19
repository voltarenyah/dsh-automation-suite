/**
 * dsh-engineering-graph — engineering knowledge graph for DeepSeek Harness
 * (engineering-graph plugin).
 *
 * The package ships **two Loader rows**, because DSH resolves tool visibility
 * per declaration scope:
 *
 *   the host row (this module, package `"."`) — composition-wide, agent-independent
 *   ────────────────────────────────────────────────────────────────────────────
 *   engine:     ctx.effect owns the C# engine subprocess (spawned lazily by the
 *               first request, structured JSON over stdio)
 *   services:   `knowledgeGraph` — the public seam for other plugins
 *               (`service.ts`; the engineering-context plugin calls it, D21);
 *               `knowledgeEngine` — this row's internal seam for its own tools
 *               row (`runtime-service.ts`), not a public interface
 *   config:     enginePath / timeouts
 *
 *   the tools row (`tools-entry.ts`, package `"./tools"`) — declared per preset
 *   ────────────────────────────────────────────────────────────────────────────
 *   tools:      knowledge_schema, knowledge_ingest, knowledge_query, registered
 *               by `tools.ts` against the host row's runtime seam
 *
 * Why the split: one row would register the tools in the host (global) plane, so
 * every agent — delegated subagents included — would inherit all three. The
 * leader preset declares the `/tools` row and keeps all three; the expert
 * subagent preset declares it too but with `includeIngest: false`, because a
 * full graph rebuild is a heavy write that belongs to the main agent's project
 * workflow. Both presets still share the one engine subprocess and the
 * `knowledgeGraph` service the host row owns.
 *
 * `apply` takes ownership of the engine subprocess through `ctx.effect` and
 * publishes the two services; it registers no tool. The engine is started lazily
 * by the first request: `apply` neither spawns nor warms it, so loading the host
 * row on a machine that has never built the C# half stays cheap and
 * side-effect free, and the disposer stops an engine that may never have existed.
 *
 * A missing engine is never a load failure. `apply` warns with the path, where
 * that path came from (`config` or `package`) and how to build the engine, then
 * continues: the host row must load on a machine that has never built the C#
 * half, exactly like the TIA Openness plugin loads without TIA Portal installed.
 * The tools row registers its tools either way and every call fails with the
 * honest transport error (`engine_not_found`), which is what tells the model the
 * difference between "the engine refused this" and "there is no engine".
 *
 * @module dsh-engineering-graph
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { ENGINE_RELATIVE_PATH, bundledEnginePath, resolveEnginePath } from './engine-path.js'
import { EngineClient, type LogSink } from './engine-client.js'
import { KnowledgeEngine, KNOWLEDGE_ENGINE_SERVICE } from './runtime-service.js'
import type { ToolDependencies } from './tools.js'
import { KnowledgeGraph, KNOWLEDGE_GRAPH_SERVICE } from './service.js'

/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'engineering-graph'

/**
 * The host row needs no service before `apply` runs.
 *
 * It used to declare `['tools']` because it registered the three tools itself.
 * Those now live in the `/tools` row (`tools-entry.ts`), which is where
 * `inject: ['tools', 'knowledgeEngine']` belongs. What is left here is the
 * engine subprocess and the two services, none of which is a dependency of
 * another plugin row — so an empty list states the truth: the host row waits for
 * nothing, and a composition that declares only the host row still loads.
 */
export const inject: readonly string[] = []

export { Config }

/**
 * Takes ownership of the engine subprocess and publishes the two seams other
 * rows read: `knowledgeGraph` for other plugins and `knowledgeEngine` for this
 * package's own `/tools` row.
 *
 * No tool is registered here; the model-facing surface is the separate
 * `tools-entry.ts` row, so an agent preset can decide whether to declare it and
 * with which config.
 *
 * Never throws when the engine executable is missing (see the module comment).
 *
 * @param ctx - the plugin context; `ctx.effect` owns the engine subprocess.
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

  // The seam this package's own `/tools` row reads back. It is internal on
  // purpose: constructing it registers a service, but no tool and no process, so
  // the host row stays tool-free and the engine stays lazy. See
  // `runtime-service.ts`.
  new KnowledgeEngine(ctx, dependencies)

  // The seam the engineering-context plugin consumes: it asks this service to
  // rebuild one device's database once it has written that device's source tree.
  // Constructing the service is what registers it, and the registration belongs to
  // this plugin's fiber, so it disappears when the plugin unloads (docs/decisions.md
  // D21). Nothing else needs the instance, which is why it is not stored.
  new KnowledgeGraph(ctx, dependencies, settings.enginePath)

  const exposed =
    `exposing the ${KNOWLEDGE_GRAPH_SERVICE} service and the ${KNOWLEDGE_ENGINE_SERVICE} seam for the /tools row`

  if (existsSync(enginePath)) {
    log.info(
      `Loaded the engineering-graph host row (${exposed}); the model-facing tools are registered by the separate ` +
        `/tools row; engine: ${enginePath} (resolved from ${source}).`,
    )
  } else {
    // Deliberately a warning, not a throw: the engine is built separately from this
    // package (it needs the .NET SDK), so requiring it here would make the bundle
    // unloadable on a checkout that has not built it. The /tools row registers the
    // tools anyway and each call reports the structured transport failure.
    log.warn(
      `The engineering-graph engine was not found at ${enginePath} (resolved from ${source}). The host row is ` +
        `loaded (${exposed}), but every call through the /tools row will fail with engine_not_found until it is ` +
        `built: build it with "dotnet build engine/EngineeringGraph.Engine.csproj -c Release" (the default output ` +
        `is ${ENGINE_RELATIVE_PATH}, Windows x64), or point the plugin's enginePath config at an existing executable.`,
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
export { EngineClient, resolveConfig, resolveEnginePath, bundledEnginePath, ENGINE_RELATIVE_PATH }
export { OPERATIONS, PROTOCOL_VERSION } from './protocol.js'
export { KnowledgeGraph, KNOWLEDGE_GRAPH_SERVICE } from './service.js'
export type { PluginConfig } from './config.js'
export type { EnginePathSource } from './engine-path.js'
export type { EngineClientStatus, EngineState, LogSink, RequestOptions } from './engine-client.js'
export type { ToolDependencies } from './tools.js'
export type { EngineError, ProgressFrame, ReadyFrame, ResultFrame, ToolOutcome } from './protocol.js'
export type { IngestDeviceOptions, KnowledgeGraphStatus } from './service.js'
