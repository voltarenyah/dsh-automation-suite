/**
 * The `tiaOpennessRuntime` seam: the host row's private handle on its own
 * `/tools` row.
 *
 * DSH resolves tool visibility per **declaration scope**, so the 26 model-facing
 * tools live in a second Loader entry (`tools-entry.ts`, the package's `./tools`
 * subpath export) that an agent preset declares only when that agent should see
 * TIA. That row owns no process and no configuration: a second
 * `ControllerProcess` would mean a second TIA Portal session, and Openness
 * allows exactly one client. The host row (`index.ts`) therefore publishes this
 * narrow object under `tiaOpennessRuntime`, and the tools row reads it back by
 * name and registers `tools.ts`'s bodies against it.
 *
 * Three properties matter:
 *
 *   1. **It is internal to this package.** Nothing outside this package should
 *      ever look it up. The public seam other plugins consume is
 *      `engineeringAccess` (`access.ts`, and the distribution's decision D12);
 *      keeping the two separate is what lets the tool row be declared per agent
 *      preset without handing other plugins a second way to drive TIA.
 *   2. **It is the tool seam, not a second API.** `request`, `status` and
 *      `verbose` are exactly the members of {@link ToolDependencies} the tool
 *      bodies need from the host row; `log` stays out, because the tools row
 *      logs under its own entry name.
 *   3. **It carries no tool bodies.** This module imports nothing from
 *      `tools.ts` except the *type* of the dependency bag, so constructing it
 *      never registers a tool — that is the whole point of the split.
 *
 * @module dsh-tia-openness-v17-min/runtime-service
 */
import { Service } from '@deepseek-ai/cordis';
/**
 * The service name the `/tools` row looks up.
 *
 * It is deliberately not `engineeringAccess`: that one is the public seam for
 * other plugins and stays on the host row. This name is an implementation
 * detail shared by the two rows of this package.
 */
export const TIA_RUNTIME_SERVICE = 'tiaOpennessRuntime';
/**
 * The tool seam the host row hands to its own `/tools` row.
 *
 * Construct it inside the host row's `apply`, next to `EngineeringAccess`, so
 * the runtime ties its lifetime to that row's fiber: `Service`'s constructor
 * registers it with `ctx.reflect.provide(name, this, …)`, whose disposer runs
 * when the host row unloads.
 *
 * The three members delegate straight to the dependency bag the host row built,
 * and they are instance-bound, so the `/tools` row can hand `runtime.request`
 * over detached exactly as {@link ToolDependencies} declares it. They are
 * read-only: the `/tools` row has no configuration of its own.
 */
export class TiaOpennessRuntime extends Service {
    dependencies;
    /** Whether tool results should carry the full controller payload (`verboseResults`). */
    verbose;
    /** Sends one whitelisted operation to the controller the host row owns. */
    request = async (operation, params, options) => await this.dependencies.request(operation, params, options);
    /** Reads the controller snapshot; never starts anything. */
    status = () => this.dependencies.status();
    /**
     * @param ctx - the host row's context the service is registered on.
     * @param dependencies - the controller seam the host row already built.
     */
    constructor(ctx, dependencies) {
        super(ctx, TIA_RUNTIME_SERVICE);
        this.dependencies = dependencies;
        this.verbose = dependencies.verbose;
    }
}
/**
 * Reads the runtime seam back out of a context.
 *
 * The `/tools` row declares `tiaOpennessRuntime` in its module-level `inject`,
 * so the loader guarantees the service is present before `apply` runs. This
 * helper keeps the cast in one place and still fails loudly for a caller that
 * applies the row by hand in a composition without the host row.
 *
 * @param ctx - the tools row's context.
 * @returns the host row's runtime seam.
 * @throws when the host row is not loaded.
 */
export function tiaOpennessRuntimeOf(ctx) {
    const runtime = ctx.get(TIA_RUNTIME_SERVICE);
    if (runtime === undefined) {
        throw new Error(`The ${TIA_RUNTIME_SERVICE} service is not in this composition: the /tools row needs the host row ` +
            `('@voltarenyah/dsh-tia-openness-v17-min') to be declared too. The row's inject waits for that service, ` +
            `so the order of the two rows does not matter — only that both are declared.`);
    }
    return runtime;
}
