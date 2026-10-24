/**
 * Plugin configuration. Every field has a default; a profile may insert the
 * bundle without a config block.
 *
 * `networkMode` is deliberately absent in this MVP: the controller always runs
 * the PLCSIM Runtime Manager in its default Softbus mode, which is the local-only
 * path chosen for this plugin. TCP/IP will be an explicit opt-in later.
 */

import Schema from '@deepseek-ai/schemastery'

import { defaultApiDir, defaultStorageRoot } from './controller.js'

export interface PluginConfig {
  /** Absolute path of the C# controller; empty means the bundled binary. */
  controllerPath: string
  /** PLCSIM Advanced API folder (4.0 baseline). */
  apiDir: string
  /** Root under which instance storage directories are created. */
  storageRoot: string
  requestTimeoutMs: number
  startupTimeoutMs: number
  shutdownGraceMs: number
  maxQueue: number
  logControllerOutput: boolean
  verboseResults: boolean
}

export const configDefaults: PluginConfig = {
  controllerPath: '',
  apiDir: defaultApiDir(),
  storageRoot: defaultStorageRoot(),
  requestTimeoutMs: 120_000,
  startupTimeoutMs: 30_000,
  shutdownGraceMs: 5_000,
  maxQueue: 8,
  logControllerOutput: false,
  verboseResults: false,
}

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
})

function positive(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < minimum ? minimum : Math.floor(value)
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function resolveConfig(config: Partial<PluginConfig> | undefined): PluginConfig {
  const source: Partial<PluginConfig> = config ?? {}
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
  }
}
