/**
 * `resolveEnginePath`: the two documented cases and the edge between them.
 *
 * The empty/whitespace case must land on the packaged executable
 * (`engine/bin/EngineeringGraph.Engine.exe`, docs/decisions.md D17) and report
 * `package`; anything else is taken as given and reports `config`, so the
 * missing-engine warning can say why it resolved where it did.
 */

import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  loadEnginePathModule,
  loadPlugin,
  missingEnginePath,
  packageRoot,
} from './helpers/harness.mjs'

const enginePath = await loadEnginePathModule()
const plugin = await loadPlugin()

test('the packaged engine path is the D17 layout, under this package', () => {
  assert.equal(enginePath.ENGINE_RELATIVE_PATH, 'engine/bin/EngineeringGraph.Engine.exe')
  assert.equal(enginePath.ENGINE_EXECUTABLE_NAME, 'EngineeringGraph.Engine.exe')
  assert.equal(enginePath.bundledEnginePath(), join(packageRoot, 'engine', 'bin', 'EngineeringGraph.Engine.exe'))
  assert.equal(enginePath.packageRoot, packageRoot)
})

test('an empty enginePath resolves to the packaged engine', () => {
  assert.deepEqual(enginePath.resolveEnginePath(''), {
    path: enginePath.bundledEnginePath(),
    source: 'package',
  })
})

test('a whitespace-only enginePath is the empty one, not a path named "  "', () => {
  assert.deepEqual(enginePath.resolveEnginePath('   '), {
    path: enginePath.bundledEnginePath(),
    source: 'package',
  })
})

test('an explicit absolute enginePath is taken as given and reports config', () => {
  const absolute = missingEnginePath()
  assert.deepEqual(enginePath.resolveEnginePath(absolute), { path: absolute, source: 'config' })
})

test('an explicit relative enginePath is resolved against the working directory', () => {
  assert.deepEqual(enginePath.resolveEnginePath('tools/EngineeringGraph.Engine.exe'), {
    path: resolve('tools/EngineeringGraph.Engine.exe'),
    source: 'config',
  })
})

test('the plugin re-exports the same resolver the engine-path module provides', () => {
  assert.equal(plugin.resolveEnginePath, enginePath.resolveEnginePath)
  assert.equal(plugin.bundledEnginePath, enginePath.bundledEnginePath)
})
