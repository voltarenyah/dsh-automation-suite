/**
 * The `/tools` row: the four model-facing simulation tools as a Loader entry of
 * their own. The host row owns the controller; this row only reads the
 * `plcsimRuntime` seam and registers the tools, so an agent preset decides
 * whether an agent sees them.
 *
 * @module dsh-plcsim-advanced/tools-entry
 */
import { registerTools } from './tools.js';
import { plcsimRuntimeOf, PLCSIM_RUNTIME_SERVICE } from './runtime-service.js';
export const name = 'plcsim-advanced-tools';
export const inject = ['tools', PLCSIM_RUNTIME_SERVICE];
export function apply(ctx, _config) {
    const runtime = plcsimRuntimeOf(ctx);
    const log = ctx.logger(name);
    const registered = registerTools(ctx, {
        request: runtime.request,
        status: runtime.status,
        verbose: runtime.verbose,
        log,
    });
    log.info(`Registered ${registered.length} PLCSIM Advanced tools (${registered.join(', ')}).`);
}
