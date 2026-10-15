/**
 * The plugin entry point: identity, the config schema, the engine seam, the tool
 * registrations, and the promise that a missing engine is a warning rather than a
 * load failure.
 *
 * The tool *contracts* (parameters, output schema, envelopes) are exercised in
 * `06-tools.test.mjs`; what is asserted here is the lifecycle seam (`ctx.effect`)
 * and the two load-time behaviours the plugin owes the host: it registers its
 * three tools, and a missing engine still only warns.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { createTestContext, loadEnginePathModule, loadPlugin, logsAt, missingEnginePath } from './helpers/harness.mjs'

const plugin = await loadPlugin()
const { bundledEnginePath } = await loadEnginePathModule()

/** The tool names this plugin registers, in registration order (deliberate; see `src/tools.ts`). */
const TOOL_NAMES = ['knowledge_schema', 'knowledge_ingest', 'knowledge_query']

test('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(plugin.name, 'engineering-graph')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'the profile needs a Config schema to validate the config block')
  assert.equal(typeof plugin.resolveConfig, 'function')
  assert.equal(typeof plugin.resolveEnginePath, 'function')
  assert.equal(typeof plugin.registerTools, 'function')
  assert.equal(typeof plugin.EngineClient, 'function')
})

test('apply registers the three knowledge tools, in order', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })
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

test('a missing engine still registers the tools: the call fails, the load does not', () => {
  const { ctx, definitions, logs } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })

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
  assert.deepEqual(logsAt(logs, 'error'), [])
})

test('apply works with no config block at all', () => {
  const { ctx } = createTestContext()
  plugin.apply(ctx)
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

test('apply has already registered the tools when the packaged engine exists', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, {})
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    TOOL_NAMES,
  )
})
