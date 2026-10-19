/**
 * Shared test harness.
 *
 * The tests exercise the *built* plugin (`lib/`) against the real
 * `@deepseek-ai/dsh-tools` runtime, which is linked from the local DeepSeek
 * Harness installation. That matters: the plugin's tool definitions go through
 * the real `defineTool`, and the tests validate the declared parameter and output
 * schemas with the registry's own validators instead of a hand-written copy.
 *
 * The `ctx` used here is a faithful stand-in for the three context members the
 * plugin touches (`tools.register`, `logger`, `effect`), because a bare cordis
 * application cannot provide the full `ctx.tools` service without the rest of the
 * harness (sessions, agents, approvals). The live profile verification covers the
 * real registry end to end.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { linkRuntime, unresolvedRuntimePackages } from '../../scripts/link-dsh-runtime.mjs'

export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const controllerExe = join(packageRoot, 'controller', 'bin', 'TiaOpennessV17Min.Controller.exe')

/** Links the harness runtime packages when a fresh checkout has none yet. */
export function ensureRuntimePackages() {
  const missing = unresolvedRuntimePackages()
  if (missing.length === 0) return
  const result = linkRuntime({ quiet: true })
  if (result.missing.length > 0) {
    throw new Error(
      `The harness runtime packages ${result.missing.join(', ')} are not available. Install DeepSeek Harness or run ` +
        '"node scripts/link-dsh-runtime.mjs" once.',
    )
  }
}

ensureRuntimePackages()

/** The real tool runtime, used to compile and validate the plugin's schemas. */
export const dshTools = await import('@deepseek-ai/dsh-tools')

/**
 * Every tool the plugin registers, in registration order.
 *
 * Spelled out on purpose: it is the one place that catches a tool silently
 * disappearing from `registerTools`. `npm run matrix:check` cross-checks the
 * count against the controller's `OperationCatalog`, and `loadOperations()`
 * gives the matching operation names.
 */
export const EXPECTED_TOOLS = [
  'open_project',
  'export_blocks',
  'import_blocks',
  'compile_plc',
  'close_project',
  'create_project',
  'save_project',
  'archive_project',
  'project_info',
  'project_languages',
  'project_texts',
  'update_project',
  'portal_settings',
  'list_plc_objects',
  'create_plc_objects',
  'delete_plc_objects',
  'write_tags',
  'set_block_attributes',
  'protect_blocks',
  'generate_source',
  'watch_and_force_tables',
  'software_units',
  'safety_status',
  'set_safety_settings',
  'safety_signatures',
  'controller_status',
]

export async function loadPlugin() {
  // A cache-busting query keeps repeated loads independent inside one test file.
  return await import(`../../lib/index.js?t=${Date.now()}${Math.random()}`)
}

/**
 * The `/tools` row: the second Loader entry, reachable as the package's
 * `./tools` subpath export in a real composition.
 */
export async function loadToolsEntry() {
  return await import(`../../lib/tools-entry.js?t=${Date.now()}${Math.random()}`)
}

export async function loadRuntimeModule() {
  return await import(`../../lib/runtime-service.js?t=${Date.now()}${Math.random()}`)
}

export async function loadToolsModule() {
  return await import(`../../lib/tools.js?t=${Date.now()}${Math.random()}`)
}

/**
 * The `/commands` row: the human-facing slash commands.
 */
export async function loadCommandsEntry() {
  return await import(`../../lib/commands-entry.js?t=${Date.now()}${Math.random()}`)
}

export async function loadCommandsModule() {
  return await import(`../../lib/commands.js?t=${Date.now()}${Math.random()}`)
}

export async function loadAccessModule() {
  return await import(`../../lib/access.js?t=${Date.now()}${Math.random()}`)
}

export async function loadControllerModule() {
  return await import(`../../lib/controller.js?t=${Date.now()}${Math.random()}`)
}

/**
 * The plugin's own operation whitelist, so a test never restates it. The C#
 * `OperationCatalog` carries the same list and `npm run matrix:check` compares
 * the two, which is what makes this single source trustworthy in the tests.
 */
export async function loadOperations() {
  const protocol = await import(`../../lib/protocol.js?t=${Date.now()}${Math.random()}`)
  return [...protocol.OPERATIONS]
}

/**
 * A minimal stand-in for the parts of `ctx` this plugin uses.
 *
 * @param {{ skills?: boolean }} [options] - `skills: false` models a profile
 *   that does not mount the skill registry: `ctx.inject(['skills'], …)` then
 *   never runs its callback, which is the state the plugin must survive.
 * @returns {{
 *   ctx: object,
 *   definitions: object[],
 *   logs: Array<[string, string, string]>,
 *   skillProviders: object[],
 *   injectedServices: string[][],
 *   unload: () => Promise<void>,
 *   registered: () => string[],
 * }}
 */
export function createTestContext(options = {}) {
  const { skills = true } = options
  /** @type {object[]} */
  const definitions = []
  /** @type {Array<[string, string, string]>} */
  const logs = []
  /** @type {Array<() => unknown>} */
  const disposers = []
  /** @type {object[]} providers registered through the stand-in skill registry */
  const skillProviders = []
  /** @type {object[]} slash-command definitions registered through the stand-in registry */
  const commands = []
  /** @type {string[][]} every service list handed to `ctx.inject` */
  const injectedServices = []

  const logger = (scope) => ({
    debug: (message) => logs.push(['debug', scope, String(message)]),
    info: (message) => logs.push(['info', scope, String(message)]),
    warn: (message) => logs.push(['warn', scope, String(message)]),
    error: (message) => logs.push(['error', scope, String(message)]),
  })

  const skillRegistry = {
    registerProvider(create) {
      skillProviders.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
      // The registration is owned by the injected child plugin, which the
      // framework disposes; the stand-in only has to hand the provider back.
      return () => {}
    },
  }

  /**
   * The command registry stand-in.
   *
   * A real `CommandRuntime` needs a session log, an agent and the Remote
   * transport to execute a line; none of that is what these tests assert. They
   * assert the registration metadata and the handler bodies, so the stand-in
   * records definitions and hands them back for direct invocation.
   */
  const commandRegistry = {
    register(definition) {
      commands.push(definition)
      return () => {
        const index = commands.indexOf(definition)
        if (index >= 0) commands.splice(index, 1)
      }
    },
  }

  /** Service instances registered through `ctx.reflect.provide`. */
  const services = new Map()

  /**
   * Normalizes the value an effect body returns.
   *
   * Cordis accepts one disposer or an iterable of them; the stand-in has to do
   * the same, or a row that returns several disposers (the `/commands` row
   * returns one per command) would silently never unregister.
   */
  const own = (disposer) => {
    if (typeof disposer === 'function') return disposer
    if (disposer !== null && typeof disposer === 'object' && Symbol.iterator in disposer) {
      const entries = [...disposer]
      return async () => {
        for (const entry of [...entries].reverse()) await entry()
      }
    }
    return () => {}
  }

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
    commands: commandRegistry,
    effect(execute, label) {
      const undo = own(execute())
      if (label !== undefined) undo.label = label
      disposers.push(undo)
      return undo
    },
    /**
     * Faithful in the one way that matters here: the callback runs only once
     * the named service exists. The stand-in has no service graph, so the
     * service either is mounted (callback now) or never appears (no callback).
     */
    inject(services2, callback) {
      injectedServices.push([...services2])
      if (skills && services2.includes('skills')) callback({ ...ctx, skills: skillRegistry })
      return () => {}
    },
    /**
     * The fiber seam a cordis `Service` needs.
     *
     * The runtime registers a service by calling
     * `ctx.reflect.provide(name, this, check)` from inside the owning fiber's
     * effect (`cordis/lib/index.js:1770-1784`), so a stand-in without `reflect`
     * cannot construct one — which is exactly what this models now that the
     * plugin exposes `engineeringAccess`.
     */
    fiber: {
      effect(execute) {
        const undo = own(execute())
        disposers.push(undo)
        return undo
      },
    },
    reflect: {
      provide(name, value) {
        if (services.has(name)) throw new Error(`service "${name}" has already been registered`)
        services.set(name, value)
        // cordis exposes a service as a property on the context it was provided in.
        ctx[name] = value
        return ctx.fiber.effect(() => () => {
          services.delete(name)
          delete ctx[name]
        })
      },
    },
    get(name) {
      return services.get(name)
    },
  }

  return {
    ctx,
    definitions,
    logs,
    services,
    skillProviders,
    commands,
    injectedServices,
    registered: () => definitions.map((definition) => definition.name),
    /** Runs every disposer in reverse registration order, as cordis does. */
    async unload() {
      for (const disposer of [...disposers].reverse()) {
        await disposer()
      }
      disposers.length = 0
    },
  }
}

export function findTool(definitions, name) {
  const definition = definitions.find((candidate) => candidate.name === name)
  if (definition === undefined) {
    throw new Error(`The tool ${name} is not registered; registered: ${definitions.map((d) => d.name).join(', ')}`)
  }
  return definition
}

/**
 * Validates arguments with the registry's own validator and returns them, so a
 * test fails when the declared schema does not accept what the tool sends.
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

/** Validates arbitrary arguments against a tool's compiled parameter schema. */
export function parameterViolations(definition, args) {
  return dshTools.validateJsonSchemaValue(definition.parameters, args)
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

export async function executeTool(definition, args, exec = {}) {
  const checked = checkedArgs(definition, args)
  return await definition.execute(checked, exec)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True while the operating system still knows the process id. */
export function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(intervalMs)
  }
}

export const controllerAvailable = existsSync(controllerExe)

/**
 * Loads the **host row**, applies it to a fresh context, and guarantees that it
 * is unloaded when the test ends — a failing test must not leak a controller
 * subprocess.
 *
 * This row registers no model-facing tool any more; tests that need the tools
 * must use {@link withTools} (or apply the `/tools` entry themselves).
 *
 * @param {import('node:test').TestContext} t - the test context providing `after`.
 * @param {object} [config] - profile config handed to `apply`.
 * @param {{ skills?: boolean }} [options] - context options (see {@link createTestContext}).
 */
export async function withPlugin(t, config = {}, options = {}) {
  const plugin = await loadPlugin()
  const harness = createTestContext(options)
  t.after(async () => {
    await harness.unload()
  })
  plugin.apply(harness.ctx, config)
  return { plugin, harness }
}

/**
 * Loads both rows the way a preset that should see TIA declares them: the host
 * row first (controller, services, skills), then the `/tools` row on the same
 * context.
 *
 * In a real composition the `/tools` row's `inject` makes the loader wait for
 * `tiaOpennessRuntime`, so the order above is what the loader itself guarantees
 * regardless of declaration order.
 *
 * @param {import('node:test').TestContext} t - the test context providing `after`.
 * @param {object} [config] - profile config handed to the host row.
 * @param {{ skills?: boolean }} [options] - context options (see {@link createTestContext}).
 */
export async function withTools(t, config = {}, options = {}) {
  const { plugin, harness } = await withPlugin(t, config, options)
  const toolsEntry = await loadToolsEntry()
  toolsEntry.apply(harness.ctx, {})
  return { plugin, toolsEntry, harness }
}
