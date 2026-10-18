/**
 * Test harness.
 *
 * The tests drive the **built** `lib/` against the **real** harness runtime: the
 * tool definitions are built by the real `defineTool` (so a schema this plugin
 * declares that the runtime would reject fails here), and only the plugin
 * context is a stand-in — a bare cordis context needs a composition this plugin
 * does not require.
 *
 * Nothing here writes outside `os.tmpdir()`.
 *
 * @module dsh-engineering-context/test/helpers
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/** Load the built tool registry (`lib/tools/index.js`). */
export async function loadToolsModule() {
  return await importBuilt('tools', 'index.js')
}

/** Load the built config module. */
export async function loadConfigModule() {
  return await importBuilt('config.js')
}

/** Load the built path helpers. */
export async function loadPathsModule() {
  return await importBuilt('paths.js')
}

/** Load the built knowledge-graph seam (`lib/knowledge-graph.js`). */
export async function loadKnowledgeGraphModule() {
  return await importBuilt('knowledge-graph.js')
}

function makeLogger(logs, scope) {
  const push = (level) => (message) => logs.push({ scope, level, message })
  return { scope, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/**
 * A stand-in plugin context carrying exactly what this plugin touches:
 * `tools.register`, `logger` (callable and usable directly, like the real one)
 * and `get(name)` for the optional services.
 *
 * @param {{ services?: Record<string, unknown> }} [options] - the services
 *   `ctx.get()` should answer with, by name (`engineeringAccess`,
 *   `workspaceRegistry`).
 * @returns {{ ctx: object, definitions: object[], logs: object[] }}
 */
export function createTestContext(options = {}) {
  const definitions = []
  const logs = []
  const services = new Map(Object.entries(options.services ?? {}))

  const logger = (name) => makeLogger(logs, name)
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
  }
  return { ctx, definitions, logs }
}

/**
 * A fake per-call execution context.
 *
 * `cwd === undefined` produces an exec with no agent at all, which is the
 * "the harness supplied no working directory" case.
 *
 * @param {string} [cwd]
 * @returns {object}
 */
export function fakeExec(cwd) {
  const base = { signal: new AbortController().signal, callId: 'test-call' }
  return cwd === undefined ? base : { ...base, agent: { session: { header: { cwd } } } }
}

/** A fake exec whose agent exists but records no cwd. */
export function fakeExecWithoutCwd() {
  return { signal: new AbortController().signal, callId: 'test-call', agent: { session: { header: {} } } }
}

/**
 * Find one registered definition by name.
 * @param {object[]} definitions
 * @param {string} name
 */
export function findTool(definitions, name) {
  const found = definitions.find((definition) => definition.name === name)
  if (found === undefined) {
    throw new Error(`tool ${name} was not registered; registered: ${definitions.map((d) => d.name).join(', ')}`)
  }
  return found
}

/**
 * Run one tool body.
 *
 * @param {object} definition
 * @param {object} args
 * @param {object} exec
 * @returns {Promise<object>} the envelope.
 */
export async function executeTool(definition, args, exec) {
  return await definition.execute(args, exec)
}

/**
 * Create a temporary workspace directory and register its cleanup.
 *
 * @param {object} t - the node:test context, for `t.after`.
 * @returns {Promise<string>} the canonical temp directory.
 */
export async function tempWorkspace(t) {
  const created = await mkdtemp(join(tmpdir(), 'dsh-eng-context-'))
  const canonical = await realpath(created)
  t.after(async () => {
    await rm(canonical, { recursive: true, force: true })
  })
  return canonical
}

/**
 * Create a file (and its parents) with the given content.
 *
 * @param {string} path
 * @param {string} [content]
 */
export async function makeFile(path, content = 'x') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * Assert the envelope is what the registry requires: exactly the declared keys,
 * and losslessly JSON-serializable.
 *
 * @param {object} value
 */
export function assertEnvelope(value) {
  const keys = Object.keys(value).sort()
  const expected = ['data', 'details', 'dryRun', 'error', 'ok', 'scope', 'summary', 'tool', 'warnings'].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`envelope keys are ${JSON.stringify(keys)}, expected ${JSON.stringify(expected)}`)
  }
  const roundTripped = JSON.parse(JSON.stringify(value))
  if (JSON.stringify(roundTripped) !== JSON.stringify(value)) {
    throw new Error('the envelope is not losslessly JSON-serializable')
  }
  return value
}

/** The text the model would see for one call. */
export function renderedText(definition, args, value) {
  return definition.output.render(args, value).map((block) => block.text).join('\n')
}
