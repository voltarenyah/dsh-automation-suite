/**
 * Lifecycle test: the host row owns the controller subprocess.
 *
 * The checklist requires that unloading the host row terminates the subprocess.
 * This test uses the *real* controller executable: it starts it through `apply`,
 * asserts the operating system sees the process, unloads the host row through
 * the disposer that `ctx.effect` registered, and then asserts the process id is
 * gone.
 *
 * The tools come from the `/tools` row, mounted by `withTools` on the same
 * context; `controller_status` is the one tool that reports what the host row's
 * process is doing, so it is the probe used throughout.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  controllerAvailable,
  findTool,
  loadOperations,
  processAlive,
  waitFor,
  withTools,
} from './helpers/harness.mjs'

async function statusOf(harness) {
  const tool = findTool(harness.definitions, 'controller_status')
  const value = await tool.execute({ include_controller_output: true }, {})
  return value.data
}

/**
 * The status tool is unregistered when the plugin unloads, so the function is
 * captured first; its closure still reaches the controller it describes.
 */
function captureStatusTool(harness) {
  return findTool(harness.definitions, 'controller_status')
}

async function statusVia(tool) {
  const value = await tool.execute({ include_controller_output: true }, {})
  return value.data
}

test('the controller is started lazily and terminated when the plugin unloads', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const { harness } = await withTools(t)
  const statusTool = captureStatusTool(harness)

  // `apply` pre-warms the process; either way the tools are registered first.
  assert.equal(harness.registered().length, 32)

  const ready = await waitFor(
    async () => {
      const status = await statusVia(statusTool)
      assert.equal(typeof status.exeExists, 'boolean')
      assert.equal(status.exeExists, true, 'the bundled controller was found')
      return status.state === 'ready' ? status : null
    },
    { what: 'the controller to report readiness' },
  )

  assert.equal(typeof ready.pid, 'number')
  assert.ok(ready.pid > 0, 'the controller reports its process id')
  assert.equal(processAlive(ready.pid), true, 'the controller process is alive')
  assert.equal(ready.ready.protocol, 1)
  assert.equal(ready.ready.openness.available, true, 'the probe found the Openness assembly')
  assert.equal(ready.ready.opennessUserGroup.isMember, true, 'the test user is in the Siemens TIA Openness group')
  assert.deepEqual(ready.ready.operations, await loadOperations())

  await harness.unload()

  assert.equal(processAlive(ready.pid), false, 'unloading the plugin must terminate the controller subprocess')
  const afterUnload = await statusVia(statusTool)
  assert.equal(afterUnload.state, 'stopped')
  assert.equal(afterUnload.pid, null)
})

test('unloading is idempotent and removes every registration it made', async (t) => {
  // A path that cannot exist makes the host row warn and never spawn anything,
  // so this test is independent of the process probes above.
  const { harness } = await withTools(t, { controllerPath: 'C:\\does\\not\\exist\\controller.exe' })
  assert.equal(harness.registered().length, 32)
  const statusTool = captureStatusTool(harness)

  await harness.unload()
  await harness.unload()

  // The framework owns the tool registrations; unloading releases them through
  // the same disposers, and running them twice must not throw.
  assert.deepEqual(harness.registered(), [])

  const status = await statusVia(statusTool)
  assert.equal(status.state, 'stopped')
})

test('a configured but missing controller path fails the call with controller_not_found', async (t) => {
  const { harness } = await withTools(t, { controllerPath: 'C:\\does\\not\\exist\\controller.exe' })

  const openProject = findTool(harness.definitions, 'open_project')
  const statusTool = captureStatusTool(harness)
  await assert.rejects(
    () => openProject.execute({ project_path: 'C:\\Demo\\Demo.ap17' }, {}),
    (error) => {
      assert.match(error.message, /controller_not_found/)
      assert.match(error.message, /C:\\does\\not\\exist\\controller\.exe/)
      return true
    },
  )

  const status = await statusVia(statusTool)
  assert.equal(status.exeExists, false)
  assert.equal(status.state, 'failed')
  assert.match(status.lastError.code, /controller_not_found/)
})
