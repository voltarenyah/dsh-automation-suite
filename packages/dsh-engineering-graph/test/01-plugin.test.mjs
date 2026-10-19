/**
 * The two Loader rows: identity, the config schema, the engine seam, the service
 * registrations, and the promise that a missing engine is a warning rather than a
 * load failure.
 *
 * Since the tool registration moved to the `/tools` row, the tool-facing
 * assertions run against `lib/tools-entry.js`; the host row must stay tool-free
 * so an agent preset can leave it undeclared. What is asserted here is the
 * lifecycle seam (`ctx.effect`), the two services the host row publishes, and the
 * two load-time behaviours the plugin owes the host: a missing engine still only
 * warns, and the tools row still registers its tools in that case.
 *
 * The tool *contracts* (parameters, output schema, envelopes) are exercised in
 * `06-tools.test.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import {
  createTestContext,
  loadEnginePathModule,
  loadPlugin,
  loadRuntimeModule,
  loadToolsEntry,
  logsAt,
  missingEnginePath,
} from './helpers/harness.mjs'

const plugin = await loadPlugin()
const toolsEntry = await loadToolsEntry()
const runtimeModule = await loadRuntimeModule()
const { bundledEnginePath } = await loadEnginePathModule()

/** The tool names this plugin registers, in registration order (deliberate; see `src/tools.ts`). */
const TOOL_NAMES = ['knowledge_schema', 'knowledge_ingest', 'knowledge_query']

/** The tool names the read-only preset keeps (`includeIngest: false`). */
const READ_ONLY_TOOL_NAMES = ['knowledge_schema', 'knowledge_query']

/** Apply the host row and then the tools row on the same context, as a preset does. */
function applyBoth(config = {}, toolsConfig = {}) {
  const harness = createTestContext()
  plugin.apply(harness.ctx, config)
  toolsEntry.apply(harness.ctx, toolsConfig)
  return harness
}

test('the host row declares its identity and waits for no service', () => {
  assert.equal(plugin.name, 'engineering-graph')
  // It used to declare ['tools'] because it registered the tools itself; those
  // now live in the /tools row, which is where that dependency belongs.
  assert.deepEqual(plugin.inject, [], 'the host row registers no tool, so it waits for no registry')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'the profile needs a Config schema to validate the config block')
  assert.equal(typeof plugin.resolveConfig, 'function')
  assert.equal(typeof plugin.resolveEnginePath, 'function')
  assert.equal(typeof plugin.EngineClient, 'function')
})

test('the /tools row declares its own identity and both dependencies', () => {
  assert.equal(toolsEntry.name, 'engineering-graph-tools')
  // The registry is where the tools go; knowledgeEngine is the host row's engine
  // seam. Declaring both is what makes the loader wait instead of racing.
  assert.deepEqual(toolsEntry.inject, ['tools', runtimeModule.KNOWLEDGE_ENGINE_SERVICE])
  assert.equal(runtimeModule.KNOWLEDGE_ENGINE_SERVICE, 'knowledgeEngine')
  assert.equal(typeof toolsEntry.apply, 'function')
  assert.ok(toolsEntry.Config !== undefined, 'the tools row needs its own Config schema for includeIngest')
  assert.equal(typeof toolsEntry.resolveToolsEntryConfig, 'function')
})

test('the host row registers no model-facing tool at all', () => {
  const { ctx, definitions, services } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })

  assert.deepEqual(definitions, [], 'the host row must not leak tools into the host (global) plane')
  assert.notEqual(services.get('knowledgeEngine'), undefined, 'the host row still publishes the seam its /tools row reads')
  assert.notEqual(services.get('knowledgeGraph'), undefined, 'the public seam other plugins consume stays on the host row')
})

test('the /tools row registers the three knowledge tools, in order', () => {
  const { definitions } = applyBoth({ enginePath: missingEnginePath() })
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    TOOL_NAMES,
  )
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.output !== undefined, `${definition.name} must declare an output schema and render`)
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('the /tools row with includeIngest:false registers only schema and query', () => {
  const { definitions } = applyBoth({ enginePath: missingEnginePath() }, { includeIngest: false })
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    READ_ONLY_TOOL_NAMES,
    'a read-only preset must not see the heavy write tool',
  )
})

test('a missing engine still registers the tools: the call fails, the load does not', () => {
  const { definitions, logs } = applyBoth({ enginePath: missingEnginePath() })

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    TOOL_NAMES,
    'the tools must be registered even without an engine, so the model gets a structured transport error',
  )
  assert.equal(logsAt(logs, 'error').length, 0)
})

test('apply registers exactly one effect disposer carrying the engine seam label', async () => {
  const { ctx, effects } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })

  assert.equal(effects.length, 1, 'the engine subprocess seam must be registered exactly once')
  assert.equal(effects[0].label, 'engineering-graph: engine process')

  // No request ever started the engine, so the disposer has nothing to stop; it
  // must still settle cleanly, because a throw here would turn unloading into an
  // error.
  await effects[0].dispose()
})

test('constructing the host row starts no engine: nothing is spawned before the first request', () => {
  const { ctx, services } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })

  const engine = services.get('knowledgeEngine')
  assert.notEqual(engine, undefined, 'the runtime seam must exist for the /tools row to read')
  assert.equal(engine.name, 'knowledgeEngine')
  // The seam is a request channel, not a process handle: `request` is the only
  // member it exposes. No `start`, no `status`, no `pid` — so constructing it
  // cannot have observed or started anything, and the engine stays lazy.
  assert.equal(typeof engine.request, 'function')
  for (const absent of ['start', 'status', 'stop', 'pid', 'state']) {
    assert.equal(engine[absent], undefined, `the seam must not expose ${absent}: it owns no process`)
  }
})

test('apply does not throw when the configured engine is missing, and says path, source and how to build', () => {
  const { ctx, logs } = createTestContext()
  const missing = missingEnginePath()

  plugin.apply(ctx, { enginePath: missing })

  const warnings = logsAt(logs, 'warn')
  assert.equal(warnings.length, 1, 'exactly one warning: the engine was not found')
  const message = warnings[0].message
  assert.ok(message.includes(missing), 'the warning must name the resolved path')
  assert.ok(message.includes('(resolved from config)'), 'the warning must name the source')
  assert.ok(message.includes('EngineeringGraph.Engine.csproj'), 'the warning must say how to build the engine')
  assert.ok(message.includes('enginePath'), 'the warning must say the config can point elsewhere')
  assert.ok(message.includes('engine_not_found'), 'the warning must name the transport error every call will produce')
  assert.ok(message.includes('/tools row'), 'the warning must say which row registers the tools')
  assert.deepEqual(logsAt(logs, 'error'), [])
})

test('apply works with no config block at all', () => {
  const { ctx } = createTestContext()
  plugin.apply(ctx)
})

test('the /tools row works with no config block at all: ingest is included by default', () => {
  const { definitions } = applyBoth({ enginePath: missingEnginePath() }, undefined)
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    TOOL_NAMES,
  )
})

test('apply reports the packaged engine without throwing, whichever branch it takes', () => {
  const { ctx, logs } = createTestContext()
  const packaged = bundledEnginePath()

  plugin.apply(ctx, {})

  // In a bare checkout the engine has not been built; in a checkout where the
  // engine work stream has built it, it exists. Both paths must be quiet on
  // stderr and must name the packaged path and the `package` source.
  if (existsSync(packaged)) {
    const info = logsAt(logs, 'info')
    assert.equal(info.length, 1)
    assert.ok(info[0].message.includes(packaged))
    assert.ok(info[0].message.includes('(resolved from package)'))
  } else {
    const warnings = logsAt(logs, 'warn')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].message.includes(packaged))
    assert.ok(warnings[0].message.includes('(resolved from package)'))
  }
  assert.deepEqual(logsAt(logs, 'error'), [])
})

test('the /tools row logs the names it registered, and says who owns the engine', () => {
  const { logs } = applyBoth({ enginePath: missingEnginePath() })
  const info = logsAt(logs, 'info').filter((entry) => entry.scope === 'engineering-graph-tools')

  assert.equal(info.length, 1)
  assert.ok(info[0].message.includes('3 engineering-graph tools'))
  assert.ok(info[0].message.includes(TOOL_NAMES.join(', ')))
  assert.ok(info[0].message.includes('host row'))
})
