/**
 * The `knowledgeEngine` seam: the host row's private handle on its own `/tools`
 * row.
 *
 * DSH resolves tool visibility per **declaration scope**, so the three
 * model-facing tools live in a second Loader entry (`tools-entry.ts`, the
 * package's `./tools` subpath export) that an agent preset declares only when
 * that agent should see them. That row owns no process and no configuration: a
 * second `EngineClient` would mean a second C# engine, and the engine is the one
 * resource the host row is supposed to own exactly once. The host row
 * (`index.ts`) therefore publishes this narrow object under `knowledgeEngine`,
 * and the tools row reads it back by name and registers `tools.ts`'s bodies
 * against it.
 *
 * Three properties matter:
 *
 *   1. **It is internal to this package.** Nothing outside this package should
 *      ever look it up. The public seam other plugins consume is the
 *      `knowledgeGraph` service (`service.ts`, and the distribution's D21),
 *      which the engineering-context plugin calls after it has written a
 *      device's source tree. Keeping the two separate is what lets the tool row
 *      be declared per agent preset without handing other plugins a second way
 *      to drive the engine.
 *   2. **It is the tool seam, not a second API.** `request` is exactly the
 *      member of {@link ToolDependencies} the tool bodies need from the host
 *      row; `log` stays out, because the tools row logs under its own entry
 *      name.
 *   3. **It never starts the engine.** Constructing it only stores the
 *      dependency bag; the engine is spawned lazily by the first `request` that
 *      reaches {@link EngineClient}. Loading the host row on a machine that has
 *      never built the C# half therefore stays cheap and side-effect free, and
 *      declaring the `/tools` row does not change that.
 *
 * @module dsh-engineering-graph/runtime-service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type { ToolDependencies } from './tools.js'

/**
 * The service name the `/tools` row looks up.
 *
 * It is deliberately not `knowledgeGraph`: that one is the public seam for
 * other plugins and stays on the host row. This name is an implementation
 * detail shared by the two rows of this package.
 */
export const KNOWLEDGE_ENGINE_SERVICE = 'knowledgeEngine'

/**
 * The tool seam the host row hands to its own `/tools` row.
 *
 * Construct it inside the host row's `apply`, next to `KnowledgeGraph`, so the
 * runtime ties its lifetime to that row's fiber: `Service`'s constructor
 * registers it with `ctx.reflect.provide(name, this, …)`, whose disposer runs
 * when the host row unloads.
 *
 * `request` is a **bound property**, not a prototype method, so the `/tools` row
 * can hand it over detached as {@link ToolDependencies} declares it — and so
 * there is no second place where the request defaults could drift.
 */
export class KnowledgeEngine extends Service {
  /**
   * Runs one engine operation. Starting the engine is the client's business,
   * not this seam's: nothing happens until a request is made.
   */
  readonly request: ToolDependencies['request']

  /**
   * @param ctx - the host row's context the service is registered on.
   * @param dependencies - the engine seam the host row already built.
   */
  constructor(ctx: Context, dependencies: ToolDependencies) {
    super(ctx, KNOWLEDGE_ENGINE_SERVICE)
    this.request = async (operation, params, options) => await dependencies.request(operation, params, options)
  }
}

/**
 * Reads the runtime seam back out of a context.
 *
 * The `/tools` row declares `knowledgeEngine` in its module-level `inject`, so
 * the loader guarantees the service is present before `apply` runs. This helper
 * keeps the cast in one place and still fails loudly for a caller that applies
 * the row by hand in a composition without the host row.
 *
 * @param ctx - the tools row's context.
 * @returns the host row's runtime seam.
 * @throws when the host row is not loaded.
 */
export function knowledgeEngineOf(ctx: Context): KnowledgeEngine {
  const runtime = ctx.get(KNOWLEDGE_ENGINE_SERVICE) as KnowledgeEngine | undefined
  if (runtime === undefined) {
    throw new Error(
      `The ${KNOWLEDGE_ENGINE_SERVICE} service is not in this composition: the /tools row needs the host row ` +
        `('@voltarenyah/dsh-engineering-graph') loaded first, in the same agent preset and ahead of the tools row.`,
    )
  }
  return runtime
}
