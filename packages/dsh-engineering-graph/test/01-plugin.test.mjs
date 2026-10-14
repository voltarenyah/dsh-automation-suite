/**
 * The plugin entry point: identity, the config schema, the engine seam, and the
 * promise that a missing engine is a warning rather than a load failure.
 *
 * This plugin registers no tools yet, so there is no tool contract to exercise
 * here; what is asserted is the lifecycle seam (`ctx.effect`) and the missing
 * engine behaviour, both of which the next step depends on.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { createTestContext, loadEnginePathModule, loadPlugin, logsAt, missingEnginePath } from './helpers/harness.mjs'

const plugin = await loadPlugin()
const { bundledEnginePath } = await loadEnginePathModule()

test('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(plugin.name, 'engineering-graph')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'the profile needs a Config schema to validate the config block')
  assert.equal(typeof plugin.resolveConfig, 'function')
  assert.equal(typeof plugin.resolveEnginePath, 'function')
})

test('apply registers no tools yet', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })
  assert.deepEqual(definitions, [], 'the tool surface is a later step')
})

test('apply registers exactly one effect disposer carrying the engine seam label', async () => {
  const { ctx, effects } = createTestContext()
  plugin.apply(ctx, { enginePath: missingEnginePath() })

  assert.equal(effects.length, 1, 'the engine subprocess seam must be registered exactly once')
  assert.equal(effects[0].label, 'engineering-graph: engine process')

  // The disposer owns nothing yet, but it must exist and settle cleanly: a
  // throw here would turn unloading into an error.
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
