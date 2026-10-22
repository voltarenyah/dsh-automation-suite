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

/** Load the separate diff entry point (`lib/diff-entry.js`). */
export async function loadDiffEntryModule() {
  return await importBuilt('diff-entry.js')
}

/** Load the built config module. */
export async function loadConfigModule() {
  return await importBuilt('config.js')
}

/** Load the built in-memory checksum cache (`lib/checksum-cache.js`). */
export async function loadChecksumCacheModule() {
  return await importBuilt('checksum-cache.js')
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
 * A stand-in `gitContext` service, recording every call in order.
 *
 * The service is consumed through `ctx.get('gitContext')`, so the tests never
 * import the git plugin; this fake answers the four discovery methods and the
 * repository-bound context (`run` for `git log -1 --format=%B`, plus `commit`).
 * It writes nothing to disk: the real repository is the git plugin's concern,
 * and the assertions here are about the *contract* (which paths, which message,
 * init or reuse), not about git's own behaviour.
 *
 * @param {{
 *   repoRoot?: string | null | ((root: string) => string | null),
 *   commitBody?: string | null,
 *   commit?: { committed: boolean, hash: string | null },
 *   commitThrows?: Error,
 *   initThrows?: Error,
 *   createThrows?: Error,
 *   head?: string | null,
 * }} [options]
 * @returns {{ service: object, calls: object[], state: { repoRoot: string | null } }}
 */
export function fakeGitContext(options = {}) {
  const calls = []
  const state = {
    repoRoot: typeof options.repoRoot === 'function' ? null : (options.repoRoot ?? null),
  }
  const resolveRoot = (root) =>
    typeof options.repoRoot === 'function' ? options.repoRoot(root) : state.repoRoot

  const contextFor = (repoDir) => ({
    repoDir,
    async run(args) {
      calls.push({ operation: 'run', repoDir, args })
      if (args[0] === 'log') {
        const body = options.commitBody ?? null
        return body === null
          ? { code: 128, stdout: '', stderr: 'fatal: your current branch does not have any commits yet' }
          : { code: 0, stdout: body, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    async runChecked(args) {
      const result = await this.run(args)
      if (result.code !== 0) throw new Error(result.stderr)
      return { stdout: result.stdout, stderr: result.stderr }
    },
    async status(paths) {
      calls.push({ operation: 'status', repoDir, paths })
      return options.status ?? []
    },
    async head() {
      calls.push({ operation: 'head', repoDir })
      return options.head ?? null
    },
    async commit(paths, message) {
      calls.push({ operation: 'commit', repoDir, paths, message })
      if (options.commitThrows !== undefined) throw options.commitThrows
      return options.commit ?? { committed: true, hash: '0123456789abcdef' }
    },
  })

  const service = {
    async isRepository(root) {
      calls.push({ operation: 'isRepository', root })
      return resolveRoot(root) !== null
    },
    async repoRoot(root) {
      calls.push({ operation: 'repoRoot', root })
      return resolveRoot(root)
    },
    async create(root) {
      calls.push({ operation: 'create', root })
      if (options.createThrows !== undefined) throw options.createThrows
      const found = resolveRoot(root)
      if (found === null) throw new Error(`not inside a git repository: ${root}`)
      return contextFor(found)
    },
    async init(root, initOptions) {
      calls.push({ operation: 'init', root, options: initOptions })
      if (options.initThrows !== undefined) throw options.initThrows
      state.repoRoot = root
      return contextFor(root)
    },
  }

  return { service, calls, state }
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
