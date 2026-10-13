/**
 * Plugin configuration.
 *
 * Every field has a default, so a profile may insert this bundle without any
 * `config` block at all. The schema is the single source of truth for the
 * user-facing names and the defaults; `resolveConfig` re-applies the same
 * defaults so the plugin behaves identically when it is loaded without the
 * loader's schema resolution (for example by a test harness).
 */
import Schema from '@deepseek-ai/schemastery';
export const configDefaults = {
    controllerPath: '',
    opennessDir: '',
    requestTimeoutMs: 300_000,
    startupTimeoutMs: 30_000,
    shutdownGraceMs: 5_000,
    maxQueue: 8,
    logControllerOutput: false,
    verboseResults: false,
};
export const Config = Schema.object({
    controllerPath: Schema.string().default(configDefaults.controllerPath),
    opennessDir: Schema.string().default(configDefaults.opennessDir),
    requestTimeoutMs: Schema.natural().default(configDefaults.requestTimeoutMs),
    startupTimeoutMs: Schema.natural().default(configDefaults.startupTimeoutMs),
    shutdownGraceMs: Schema.natural().default(configDefaults.shutdownGraceMs),
    maxQueue: Schema.natural().default(configDefaults.maxQueue),
    logControllerOutput: Schema.boolean().default(configDefaults.logControllerOutput),
    verboseResults: Schema.boolean().default(configDefaults.verboseResults),
});
function positive(value, fallback, minimum) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return value < minimum ? minimum : Math.floor(value);
}
function text(value, fallback) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}
function flag(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/**
 * Normalizes whatever the loader (or a test) handed to `apply` into a complete,
 * range-checked configuration.
 */
export function resolveConfig(config) {
    const source = config ?? {};
    return {
        controllerPath: text(source.controllerPath, configDefaults.controllerPath),
        opennessDir: text(source.opennessDir, configDefaults.opennessDir),
        requestTimeoutMs: positive(source.requestTimeoutMs, configDefaults.requestTimeoutMs, 1_000),
        startupTimeoutMs: positive(source.startupTimeoutMs, configDefaults.startupTimeoutMs, 1_000),
        shutdownGraceMs: positive(source.shutdownGraceMs, configDefaults.shutdownGraceMs, 0),
        maxQueue: positive(source.maxQueue, configDefaults.maxQueue, 1),
        logControllerOutput: flag(source.logControllerOutput, configDefaults.logControllerOutput),
        verboseResults: flag(source.verboseResults, configDefaults.verboseResults),
    };
}
