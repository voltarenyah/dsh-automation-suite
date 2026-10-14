/**
 * Configuration: `resolveConfig` defaults and validation, and the claim that the
 * declared `Config` schema (built by the **real** schemastery) applies the same
 * defaults the plugin itself would.
 *
 * The plugin must behave identically whether the loader validated the config
 * block or a test called `apply` directly, which is exactly what these two paths
 * are compared for.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadConfigModule, loadPlugin } from './helpers/harness.mjs'

const { configDefaults, resolveConfig } = await loadConfigModule()
const plugin = await loadPlugin()

test('resolveConfig fills in every default', () => {
  assert.deepEqual(resolveConfig(), configDefaults)
  assert.deepEqual(resolveConfig({}), configDefaults)
  assert.equal(configDefaults.requestTimeoutMs, 300_000)
  assert.equal(configDefaults.startupTimeoutMs, 30_000)
  assert.equal(configDefaults.logEngineOutput, false)
  assert.equal(configDefaults.enginePath, '', 'empty means the packaged engine')
})

test('the real schemastery schema applies the same defaults', () => {
  assert.deepEqual(plugin.Config({}), configDefaults)
})

test('the real schemastery schema rejects values the plugin would also refuse to trust', () => {
  assert.throws(() => plugin.Config({ requestTimeoutMs: -1 }), 'a negative timeout is not a natural number')
  assert.throws(() => plugin.Config({ startupTimeoutMs: -1 }))
  assert.throws(() => plugin.Config({ logEngineOutput: 'yes' }))
  assert.throws(() => plugin.Config({ enginePath: 5 }))
})

test('enginePath is trimmed; whitespace-only falls back to the packaged engine', () => {
  assert.equal(resolveConfig({ enginePath: '  ' }).enginePath, configDefaults.enginePath)
  assert.equal(resolveConfig({ enginePath: 5 }).enginePath, configDefaults.enginePath)
  assert.equal(resolveConfig({ enginePath: ' C:\\tools\\EngineeringGraph.Engine.exe ' }).enginePath, 'C:\\tools\\EngineeringGraph.Engine.exe')
})

test('timeouts clamp up to their floor and fall back on non-numbers', () => {
  assert.equal(resolveConfig({ requestTimeoutMs: 10 }).requestTimeoutMs, 1_000)
  assert.equal(resolveConfig({ startupTimeoutMs: 0 }).startupTimeoutMs, 1_000)
  assert.equal(resolveConfig({ requestTimeoutMs: 1_500.7 }).requestTimeoutMs, 1_500)

  for (const bad of ['soon', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveConfig({ requestTimeoutMs: bad }).requestTimeoutMs, configDefaults.requestTimeoutMs, `requestTimeoutMs ${String(bad)}`)
    assert.equal(resolveConfig({ startupTimeoutMs: bad }).startupTimeoutMs, configDefaults.startupTimeoutMs, `startupTimeoutMs ${String(bad)}`)
  }
})

test('logEngineOutput only trusts a boolean', () => {
  assert.equal(resolveConfig({ logEngineOutput: true }).logEngineOutput, true)
  for (const bad of ['yes', 1, 0, null]) {
    assert.equal(resolveConfig({ logEngineOutput: bad }).logEngineOutput, configDefaults.logEngineOutput, `logEngineOutput ${String(bad)}`)
  }
})
