/**
 * Test harness.
 *
 * The tests drive the **built** `lib/` against the **real** harness runtime: the
 * tool definitions go through the real `defineTool`, the schemas are validated
 * with the registry's own `validateJsonSchemaValue`, and the schema/config
 * modules are the real `@deepseek-ai/schemastery` ones. Only the plugin context is
 * a stand-in — a bare cordis context needs a composition this plugin does not
 * require.
 *
 * The stand-in context carries exactly what this plugin touches: `logger`
 * (callable and usable directly, like the real one), `get(name)` for optional
 * services, `effect(execute, label)` for the lifecycle seam, and
 * `tools.register`, whose returned disposer is honoured (the TIA Openness plugin's harness does
 * the same). `unload()` runs those disposers in reverse, which is how a test
 * guarantees that no engine subprocess outlives it.
 *
 * Test data never leaves `os.tmpdir()`.
 *
 * @module dsh-engineering-graph/test/helpers
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { linkRuntime } from '../../scripts/link-dsh-runtime.mjs'

/** This package's root directory: up from `test/helpers/`. */
export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Links the harness runtime packages when a fresh checkout has none yet.
 *
 * The sibling packages do the same, for the same reason: `pnpm -r test` on a bare
 * checkout must work without a manual first step. This only creates the
 * `node_modules/@deepseek-ai` junctions inside this package; it never extracts the
 * shared runtime cache, which lives outside the repository (see
 * `scripts/link-dsh-runtime.mjs`).
 */
export function ensureRuntimePackages() {
  const result = linkRuntime({ quiet: true })
  if (result.missing.length > 0) {
    throw new Error(
      `The harness runtime packages ${result.missing.join(', ')} are not available. Install DeepSeek Harness, or run ` +
        '"node scripts/link-dsh-runtime.mjs" once. The shared cache is (re)built by the sibling package: ' +
        '"pnpm --filter @voltarenyah/dsh-tia-openness-v17-min run link:runtime".',
    )
  }
}

ensureRuntimePackages()

/** The real tool runtime, used to compile and validate the plugin's schemas. */
export const dshTools = await import('@deepseek-ai/dsh-tools')

/**
 * Import a built module by absolute path.
 *
 * A Windows absolute path is not a valid ESM specifier (`c:` is read as a
 * scheme), so the path has to become a `file://` URL first.
 */
async function importBuilt(...segments) {
  return await import(pathToFileURL(join(packageRoot, 'lib', ...segments)).href)
}

/** Load the built plugin entry point (`lib/index.js`). */
export async function loadPlugin() {
  return await importBuilt('index.js')
}

/** Load the built config module. */
export async function loadConfigModule() {
  return await importBuilt('config.js')
}

/** Load the built engine-path module. */
export async function loadEnginePathModule() {
  return await importBuilt('engine-path.js')
}

/** Load the built protocol module (operations, frame types, envelope). */
export async function loadProtocolModule() {
  return await importBuilt('protocol.js')
}

/** Load the built engine client module. */
export async function loadEngineClientModule() {
  return await importBuilt('engine-client.js')
}

/** Load the built tools module. */
export async function loadToolsModule() {
  return await importBuilt('tools.js')
}

/** The engine executable this package ships, resolved the way `apply` resolves it. */
export const enginePath = (await loadEnginePathModule()).bundledEnginePath()

/**
 * Whether the C# half has been built in this checkout.
 *
 * `engine/bin/` is a build artifact (`.gitignore` excludes it), so the tests that
 * need a real engine skip with the command to fix that instead of failing: a red
 * suite must mean "something is broken", not "you forgot to build the other half".
 */
export const engineAvailable = existsSync(enginePath)

/** The reason to hand to `t.skip()` when the engine is not built. */
export const engineSkipReason = `engine not built at ${enginePath} — build it with: pwsh -NoProfile -File engine/build.ps1`

/**
 * The real engine client wired the way `apply` wires it, for tests that want the
 * wire itself (the tests that go through the tools use `registerTools` instead).
 *
 * @param {{ enginePath?: string, requestTimeoutMs?: number, startupTimeoutMs?: number, logs?: object[], logEngineOutput?: boolean, launchArgs?: readonly string[] }} [options]
 */
export async function engineClient(options = {}) {
  const { EngineClient } = await loadEngineClientModule()
  const logs = options.logs ?? []
  return new EngineClient({
    enginePath: options.enginePath ?? enginePath,
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
    logEngineOutput: options.logEngineOutput ?? false,
    log: makeLogger(logs, 'engine'),
    ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }),
  })
}

/** Path of the deliberately broken protocol peer (`test/helpers/stub-engine.mjs`). */
export const stubEnginePath = join(packageRoot, 'test', 'helpers', 'stub-engine.mjs')

/**
 * A client pointed at the stub engine in one of its failure modes.
 *
 * The stub is a Node script, so it is launched as `<node> <stub> <mode>`; the
 * client's `launchArgs` is the documented seam for exactly this (the TIA Openness plugin's
 * controller stub uses the same one).
 *
 * @param {'ready' | 'mismatch' | 'unknown-operations' | 'silent' | 'stall' | 'die'} mode
 * @param {{ requestTimeoutMs?: number, startupTimeoutMs?: number, logs?: object[] }} [options]
 */
export async function stubEngineClient(mode, options = {}) {
  return await engineClient({
    enginePath: process.execPath,
    launchArgs: [stubEnginePath, mode],
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
    ...(options.logs === undefined ? {} : { logs: options.logs }),
  })
}

function makeLogger(logs, scope) {
  const push = (level) => (message) => logs.push({ scope, level, message })
  return { scope, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/**
 * A stand-in plugin context carrying exactly what this plugin touches:
 * `logger` (callable and usable directly, like the real one), `get(name)` for
 * optional services, `effect(execute, label)` for the lifecycle seam, and
 * `tools.register`.
 *
 * The effect stub mirrors the real contract the way the plugin uses it: the body
 * runs immediately, its result **is** the disposer, and the returned disposer
 * awaits it. `effects` therefore holds `{ label, dispose }` for every effect the
 * plugin registered, and `unload()` runs them in reverse registration order, the
 * way cordis does — which is what keeps a test from leaking the engine.
 *
 * @returns {{ ctx: object, definitions: object[], logs: object[], effects: object[], services: Map<string, unknown>, registered: () => string[], unload: () => Promise<void> }}
 */
export function createTestContext() {
  const definitions = []
  const logs = []
  const effects = []
  const services = new Map()
  const disposers = []

  const logger = (scope) => makeLogger(logs, scope)
  Object.assign(logger, makeLogger(logs, 'root'))

  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        const undo = () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
        disposers.push(undo)
        return undo
      },
    },
    logger,
    get(name) {
      return services.get(name)
    },
    effect(execute, label = 'anonymous') {
      const dispose = execute()
      const entry = { label, dispose }
      effects.push(entry)
      disposers.push(dispose)
      return async () => await dispose()
    },
  }

  return {
    ctx,
    definitions,
    logs,
    effects,
    services,
    registered: () => definitions.map((definition) => definition.name),
    /** Runs every disposer in reverse registration order, as cordis does. */
    async unload() {
      for (const disposer of [...disposers].reverse()) await disposer()
      disposers.length = 0
    },
  }
}

/**
 * Collect the log entries at one level.
 *
 * @param {object[]} logs
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 */
export function logsAt(logs, level) {
  return logs.filter((entry) => entry.level === level)
}

/**
 * A path that certainly does not exist, for the "engine is missing" cases.
 *
 * The packaged engine may or may not exist in a given checkout, so a deterministic
 * missing path has to be supplied through `enginePath` instead of relying on the
 * packaged one.
 *
 * @returns {string}
 */
export function missingEnginePath() {
  return join(packageRoot, 'test', 'does-not-exist', 'EngineeringGraph.Engine.exe')
}

/** Finds a registered tool by name, failing loudly when it is missing. */
export function findTool(definitions, name) {
  const definition = definitions.find((candidate) => candidate.name === name)
  if (definition === undefined) {
    throw new Error(`The tool ${name} is not registered; registered: ${definitions.map((d) => d.name).join(', ')}`)
  }
  return definition
}

/**
 * Validates arguments with the registry's own validator and returns them, so a
 * test fails when the declared schema does not accept what the test passes.
 *
 * `defineTool` compiles the author-facing parameter DSL into raw JSON Schema
 * before the registry ever sees it, so the registered definition's `parameters`
 * is already the enforced schema.
 */
export function checkedArgs(definition, args) {
  const violations = dshTools.validateJsonSchemaValue(definition.parameters, args)
  if (violations.length > 0) {
    throw new Error(`${definition.name}: the declared parameters reject the test arguments: ${violations.join('; ')}`)
  }
  return args
}

/**
 * Validates a tool's canonical value against its declared output schema with the
 * same validator the registry uses at run time.
 */
export function assertOutcomeMatchesSchema(definition, value) {
  const violations = dshTools.validateJsonSchemaValue(definition.output.schema, value)
  if (violations.length > 0) {
    throw new Error(`${definition.name}: the canonical value violates its output schema: ${violations.join('; ')}`)
  }
}

/** Renders a tool's canonical value the way the registry would. */
export function renderedText(definition, args, value) {
  const blocks = definition.output.render(checkedArgs(definition, args), value)
  return blocks.map((block) => block.text).join('\n')
}

/** Runs a tool body the way the registry does: arguments validated first. */
export async function executeTool(definition, args, exec = {}) {
  return await definition.execute(checkedArgs(definition, args), exec)
}

/** A promise that settles after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls `predicate` until it is truthy.
 *
 * Used for the one thing the client delivers asynchronously: the engine's stderr
 * notes arrive on their own stream, so a test that wants to observe them cannot
 * assume they were dispatched by the time the `ready` frame resolved.
 */
export async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(intervalMs)
  }
}

/** True while the operating system still knows the process id. */
export function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to somebody else.
    return error.code === 'EPERM'
  }
}
