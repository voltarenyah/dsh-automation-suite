/**
 * Controller protocol tests.
 *
 * Two halves:
 *
 * 1. The real controller executable: the ready handshake, argument validation,
 *    the whitelist and graceful shutdown.
 * 2. Stub controllers launched through the same client: a stuck controller, one
 *    that exits mid-request, one that speaks another protocol version and one
 *    that writes noise to stdout. These are the transport paths that would
 *    otherwise only fail on a broken TIA Portal installation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  controllerExe,
  controllerAvailable,
  loadControllerModule,
  sleep,
  waitFor,
} from './helpers/harness.mjs'
import { answeringStub, crashingStub, dyingStub, noisyStub, progressStub, silentStub } from './helpers/stubs.mjs'

/** Used as the stub "controller" executable: Node running a stub script. */
const nodeExecutable = process.execPath

const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

function options(overrides) {
  return {
    exePath: '',
    opennessDir: '',
    requestTimeoutMs: 30_000,
    startupTimeoutMs: 30_000,
    shutdownGraceMs: 5_000,
    maxQueue: 8,
    logControllerOutput: false,
    log: quietLog,
    ...overrides,
  }
}

async function realController(overrides = {}) {
  const controller = await loadControllerModule()
  return new controller.ControllerProcess(options({ exePath: controllerExe, ...overrides }))
}

test('asciiStringify escapes every non-ASCII code point', async () => {
  const controller = await loadControllerModule()
  const text = controller.asciiStringify({ name: '中文 "quoted" \n\t\\ \u{1F600}', paths: ['C:\\Projekte\\中文'] })

  assert.ok(!/[\u007f-\uffff]/.test(text), 'the serialized request is pure ASCII')
  assert.deepEqual(JSON.parse(text), { name: '中文 "quoted" \n\t\\ \u{1F600}', paths: ['C:\\Projekte\\中文'] })
})

test('resolveControllerPath prefers config, then the environment, then the bundle', async () => {
  const controller = await loadControllerModule()

  const fromConfig = controller.resolveControllerPath('C:\\custom\\controller.exe')
  assert.equal(fromConfig.source, 'config')
  assert.equal(fromConfig.path, 'C:\\custom\\controller.exe')

  const previous = process.env['TIA_OPENNESS_V17_MIN_CONTROLLER']
  process.env['TIA_OPENNESS_V17_MIN_CONTROLLER'] = 'C:\\env\\controller.exe'
  try {
    const fromEnvironment = controller.resolveControllerPath('')
    assert.equal(fromEnvironment.source, 'environment')
    assert.equal(fromEnvironment.path, 'C:\\env\\controller.exe')
  } finally {
    if (previous === undefined) delete process.env['TIA_OPENNESS_V17_MIN_CONTROLLER']
    else process.env['TIA_OPENNESS_V17_MIN_CONTROLLER'] = previous
  }

  const bundled = controller.resolveControllerPath('')
  assert.equal(bundled.source, 'package')
  assert.match(bundled.path, /controller[\\/]bin[\\/]TiaOpennessV17Min\.Controller\.exe$/)
})

test('a missing executable is a structured controller_not_found failure', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(options({ exePath: 'C:\\nope\\controller.exe' }))

  await assert.rejects(
    () => instance.start(),
    (error) => {
      assert.equal(error.code, 'controller_not_found')
      assert.match(error.message, /npm run build:controller/)
      return true
    },
  )
  assert.equal(instance.status().state, 'failed')
})

test('the real controller performs the ready handshake', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const instance = await realController()
  t.after(async () => {
    await instance.stop()
  })

  const ready = await instance.start()
  assert.equal(ready.type, 'ready')
  assert.equal(ready.protocol, 1)
  assert.equal(ready.operations.length, 5)
  assert.equal(ready.openness.available, true)
  assert.equal(instance.status().state, 'ready')

  // Starting twice reuses the same process.
  const again = await instance.start()
  assert.equal(again.pid, ready.pid)
})

test('the real controller refuses anything outside the whitelist', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const instance = await realController()
  t.after(async () => {
    await instance.stop()
  })

  const frame = await instance.request('RunScript', { code: 'System.IO.File.Delete("x")' })
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'unsupported_operation')
  assert.deepEqual(frame.error.details.allowed, ['OpenProject', 'ExportBlocks', 'ImportBlocks', 'CompilePlc', 'CloseProject'])
  assert.equal(instance.status().state, 'ready', 'a refused operation keeps the controller usable')
})

test('the real controller reports invalid parameters as a structured failure', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const instance = await realController()
  t.after(async () => {
    await instance.stop()
  })

  const missing = await instance.request('ExportBlocks', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'invalid_params')
  assert.match(missing.error.message, /output_dir/)

  const wrongType = await instance.request('ExportBlocks', { output_dir: 'C:\\out', overwrite: 'yes please' })
  assert.equal(wrongType.ok, false)
  assert.equal(wrongType.error.code, 'invalid_params')
})

test('an operation that needs a project fails with project_not_open', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const instance = await realController()
  t.after(async () => {
    await instance.stop()
  })

  const frame = await instance.request('CompilePlc', {})
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'project_not_open')

  const close = await instance.request('CloseProject', { dry_run: false })
  assert.equal(close.ok, false)
  assert.equal(close.error.code, 'project_not_open')
})

test('stopping the controller releases the process', async () => {
  if (!controllerAvailable) {
    return
  }

  const instance = await realController()
  await instance.start()
  const pid = instance.pid
  assert.ok(pid > 0)

  await instance.stop()
  assert.equal(instance.status().state, 'stopped')
  assert.equal(instance.pid, null)

  // The next request starts a fresh controller.
  const ready = await instance.start()
  assert.notEqual(ready.pid, pid)
  await instance.stop()
})

test('progress frames reach the caller', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [progressStub], startupTimeoutMs: 15_000 }),
  )

  const seen = []
  const frame = await instance.request('ExportBlocks', {}, { onProgress: (progress) => seen.push(progress) })
  assert.equal(frame.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].phase, 'export')

  await instance.stop()
})

test('a controller that never answers hits the deadline and is terminated', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [silentStub], requestTimeoutMs: 700, startupTimeoutMs: 15_000 }),
  )

  const pid = (await instance.start()).pid
  await assert.rejects(
    () => instance.request('ExportBlocks', {}),
    (error) => {
      assert.equal(error.code, 'controller_timeout')
      assert.match(error.message, /cannot be cancelled/)
      return true
    },
  )

  assert.equal(instance.status().lastError.code, 'controller_timeout')
  await waitFor(() => instance.pid === null, { what: 'the stuck controller to be terminated', timeoutMs: 10_000 })
  assert.equal(instance.pid, null)

  // The transport recovers: the next request starts a replacement.
  const replacement = await instance.start()
  assert.notEqual(replacement.pid, pid)
  await instance.stop()
})

test('a controller that exits mid-request fails the request with its stderr', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [dyingStub], startupTimeoutMs: 15_000 }),
  )

  await assert.rejects(
    () => instance.request('ExportBlocks', {}),
    (error) => {
      assert.equal(error.code, 'controller_exited')
      assert.match(error.message, /stub: dying now/)
      return true
    },
  )
  assert.equal(instance.status().state, 'failed')
})

test('a controller that never reports readiness fails the handshake', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [crashingStub], startupTimeoutMs: 15_000 }),
  )

  await assert.rejects(
    () => instance.start(),
    (error) => {
      assert.equal(error.code, 'controller_exited')
      assert.match(error.message, /stub: cannot start/)
      return true
    },
  )
})

test('a controller speaking another protocol version is rejected', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [noisyStub], startupTimeoutMs: 15_000 }),
  )

  await assert.rejects(
    () => instance.start(),
    (error) => {
      assert.equal(error.code, 'controller_protocol_mismatch')
      return true
    },
  )
  await instance.stop()
})

test('a stub that refuses everything still produces well-formed result frames', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [answeringStub], startupTimeoutMs: 15_000 }),
  )

  const frame = await instance.request('OpenProject', { project_path: 'C:\\中文\\Demo.ap17' })
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'unsupported_operation')
  // The non-ASCII path survived the ASCII-escaped transport.
  assert.deepEqual(frame.error.details.echo, { project_path: 'C:\\中文\\Demo.ap17' })
  assert.equal(instance.status().requestsServed, 1)

  await instance.stop()
})

test('every request is serialized: overlapping calls never interleave', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [progressStub], startupTimeoutMs: 15_000 }),
  )

  const frames = await Promise.all([
    instance.request('ExportBlocks', { output_dir: 'a' }),
    instance.request('ExportBlocks', { output_dir: 'b' }),
    instance.request('ExportBlocks', { output_dir: 'c' }),
  ])

  assert.equal(frames.length, 3)
  assert.deepEqual(
    frames.map((frame) => frame.id).filter((id) => typeof id === 'string').length,
    3,
    'every request received its own response',
  )
  assert.equal(instance.status().requestsServed, 3)
  assert.equal(instance.status().queueDepth, 0)

  await instance.stop()
})

test('the queue refuses work beyond maxQueue', async () => {
  const controller = await loadControllerModule()
  const instance = new controller.ControllerProcess(
    options({ exePath: nodeExecutable, launchArgs: [silentStub], requestTimeoutMs: 900, maxQueue: 2, startupTimeoutMs: 15_000 }),
  )

  await instance.start()
  const inflight = [
    instance.request('ExportBlocks', {}).catch((error) => error),
    instance.request('ExportBlocks', {}).catch((error) => error),
  ]
  await sleep(50)

  await assert.rejects(
    () => instance.request('ExportBlocks', {}),
    (error) => {
      assert.equal(error.code, 'controller_busy')
      return true
    },
  )

  const settled = await Promise.all(inflight)
  assert.equal(settled.length, 2)
  for (const outcome of settled) {
    assert.equal(outcome.code, 'controller_timeout', 'both queued requests hit their deadline')
  }
  await waitFor(() => instance.pid === null, { what: 'the stuck controller to be terminated', timeoutMs: 10_000 })

  // Both timed-out requests restarted the controller; the last one must not be
  // left behind. This is the regression guard for a late `exit` event from a
  // replaced child clearing the reference to its healthy replacement.
  await instance.stop()
  assert.equal(instance.pid, null)
})
