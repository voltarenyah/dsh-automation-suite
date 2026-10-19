/**
 * The two-row wiring against the **real** cordis service graph.
 *
 * `01-load.test.mjs` drives the stand-in harness, which cannot say whether a
 * *sibling* Loader row can read the host row's `tiaOpennessRuntime` service:
 * that resolution belongs to cordis (`ctx.reflect.provide` plus the root-level
 * service store). This file mounts both rows as sibling plugins on a bare
 * `Context` — with only a recording `tools` service, the single thing either row
 * needs — and asserts what the loader does in a real composition: the `/tools`
 * row's `inject` is satisfied by the host row, it registers the 26 tools through
 * the seam, and the seam is gone once the host row unloads.
 *
 * The bare context has no `skills` service, which the host row treats as
 * optional; that also keeps this file independent of `07-skills-registry`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { EXPECTED_TOOLS, loadPlugin, loadRuntimeModule, loadToolsEntry } from './helpers/harness.mjs'

/** A path that cannot exist, so the host row never spawns a controller. */
const MISSING_CONTROLLER = 'C:\\does\\not\\exist\\controller.exe'

/** A bare context plus a tool registry that records the names it receives. */
function recordingContext() {
  const ctx = new Context()
  /** @type {string[]} */
  const names = []
  ctx.provide('tools', {
    register(definition) {
      names.push(definition.name)
      return () => {}
    },
  })
  return { ctx, names }
}

test('the /tools row reads the host row’s runtime seam across sibling rows', async (t) => {
  const host = await loadPlugin()
  const entry = await loadToolsEntry()
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()
  const { ctx, names } = recordingContext()

  const hostFiber = ctx.plugin({
    name: 'tia-openness-v17-min',
    inject: [],
    apply: (scoped) => host.apply(scoped, { controllerPath: MISSING_CONTROLLER }),
  })
  await hostFiber
  t.after(async () => {
    await hostFiber.dispose()
  })

  assert.notEqual(ctx.get(TIA_RUNTIME_SERVICE), undefined, 'the sibling context sees the service the host row provided')

  // Mounted the way the loader does: `inject` holds the row until both services
  // exist, which is why the two rows may appear in any composition order.
  const toolsFiber = ctx.plugin({
    name: 'tia-openness-v17-min-tools',
    inject: ['tools', TIA_RUNTIME_SERVICE],
    apply: (scoped) => entry.apply(scoped, {}),
  })
  await toolsFiber
  t.after(async () => {
    await toolsFiber.dispose()
  })

  assert.deepEqual(names, EXPECTED_TOOLS, 'the tools row registers the same 26 names, in the same order')
})

test('the host row registers no tool on a real context, and unloading removes its seam', async () => {
  const host = await loadPlugin()
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()
  const { ctx, names } = recordingContext()

  const hostFiber = ctx.plugin({
    name: 'tia-openness-v17-min',
    inject: [],
    apply: (scoped) => host.apply(scoped, { controllerPath: MISSING_CONTROLLER }),
  })
  await hostFiber

  assert.deepEqual(names, [], 'the host row must not put a tool in the host (global) plane')
  assert.notEqual(ctx.get(TIA_RUNTIME_SERVICE), undefined)

  await hostFiber.dispose()
  assert.equal(ctx.get(TIA_RUNTIME_SERVICE), undefined, 'the seam belongs to the host row’s fiber')
})
