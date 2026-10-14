/**
 * Test harness.
 *
 * The tests drive the **built** `lib/` against the **real** harness runtime: the
 * schema is the real `Schema` from `@deepseek-ai/schemastery` (so a config this
 * plugin declares that the runtime would reject fails here), and only the plugin
 * context is a stand-in — a bare cordis context needs a composition this plugin
 * does not require.
 *
 * The stand-in context is deliberately not a "fake registry": this plugin
 * registers no tools yet, and the `tools.register` recorder exists only so the
 * test can assert that fact.
 *
 * Nothing here writes outside `os.tmpdir()`.
 *
 * @module dsh-engineering-graph/test/helpers
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This package's root directory: up from `test/helpers/`. */
export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

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

function makeLogger(logs, scope) {
  const push = (level) => (message) => logs.push({ scope, level, message })
  return { scope, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/**
 * A stand-in plugin context carrying exactly what this plugin touches:
 * `logger` (callable and usable directly, like the real one), `get(name)` for
 * optional services, `effect(execute, label)` for the lifecycle seam, and
 * `tools.register` only so the test can prove nothing was registered.
 *
 * The effect stub mirrors the real contract the way the plugin uses it: the body
 * runs immediately, its result **is** the disposer, and the returned disposer
 * awaits it. `effects` therefore holds `{ label, dispose }` for every effect the
 * plugin registered.
 *
 * @returns {{ ctx: object, definitions: object[], logs: object[], effects: object[], services: Map<string, unknown> }}
 */
export function createTestContext() {
  const definitions = []
  const logs = []
  const effects = []
  const services = new Map()

  const logger = (scope) => makeLogger(logs, scope)
  Object.assign(logger, makeLogger(logs, 'root'))

  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    logger,
    get(name) {
      return services.get(name)
    },
    effect(execute, label = 'anonymous') {
      const dispose = execute()
      effects.push({ label, dispose })
      return async () => await dispose()
    },
  }
  return { ctx, definitions, logs, effects, services }
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
 * The packaged engine may or may not exist in a given checkout (another work
 * stream vendors and builds `engine/`), so a deterministic missing path has to be
 * supplied through `enginePath` instead of relying on the packaged one.
 *
 * @returns {string}
 */
export function missingEnginePath() {
  return join(packageRoot, 'test', 'does-not-exist', 'EngineeringGraph.Engine.exe')
}
