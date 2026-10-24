/**
 * Plugin configuration. Every field has a default; a profile may insert the
 * bundle without a config block.
 *
 * `networkMode` is deliberately absent in this MVP: the controller always runs
 * the PLCSIM Runtime Manager in its default Softbus mode, which is the local-only
 * path chosen for this plugin. TCP/IP will be an explicit opt-in later.
 */
import Schema from '@deepseek-ai/schemastery';
import { defaultApiDir, defaultStorageRoot } from './controller.js';
export const configDefaults = {
    controllerPath: '',
    apiDir: defaultApiDir(),
    storageRoot: defaultStorageRoot(),
    requestTimeoutMs: 120_000,
    startupTimeoutMs: 30_000,
    shutdownGraceMs: 5_000,
    maxQueue: 8,
    logControllerOutput: false,
    verboseResults: false,
};
export const Config = Schema.object({
    controllerPath: Schema.string().default(configDefaults.controllerPath),
    apiDir: Schema.string().default(configDefaults.apiDir),
    storageRoot: Schema.string().default(configDefaults.storageRoot),
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
export function resolveConfig(config) {
    const source = config ?? {};
    return {
        controllerPath: text(source.controllerPath, configDefaults.controllerPath),
        apiDir: text(source.apiDir, configDefaults.apiDir),
        storageRoot: text(source.storageRoot, configDefaults.storageRoot),
        requestTimeoutMs: positive(source.requestTimeoutMs, configDefaults.requestTimeoutMs, 1_000),
        startupTimeoutMs: positive(source.startupTimeoutMs, configDefaults.startupTimeoutMs, 1_000),
        shutdownGraceMs: positive(source.shutdownGraceMs, configDefaults.shutdownGraceMs, 0),
        maxQueue: positive(source.maxQueue, configDefaults.maxQueue, 1),
        logControllerOutput: flag(source.logControllerOutput, configDefaults.logControllerOutput),
        verboseResults: flag(source.verboseResults, configDefaults.verboseResults),
    };
}
