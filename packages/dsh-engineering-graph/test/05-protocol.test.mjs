/**
 * The wire contract, on both sides of the channel.
 *
 * Two things are asserted here that nothing else can:
 *
 * 1. `OPERATIONS` (this plugin) and the operation list the engine prints in its
 *    `ready` frame (the C# `OperationCatalog`) are the *same list in the same
 *    order*. The C# catalog documents that requirement on its side
 *    (`engine/Protocol.cs`), and until this test existed nothing checked it from
 *    the TypeScript side — a rename on either side would only have shown up as an
 *    `unsupported_operation` at run time, in production.
 * 2. The frame reader tolerates everything that is not a frame, and the transport
 *    failures are transport failures (a throw whose message starts with the stable
 *    code), not operation outcomes.
 *
 * The engine is a build artifact, so the tests that need it skip with the command
 * to build it instead of failing (see `test/04-engine.test.mjs` for the reasoning).
 *
 * @module dsh-engineering-graph/test/protocol
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  engineAvailable,
  engineClient,
  engineSkipReason,
  loadProtocolModule,
  logsAt,
  missingEnginePath,
  waitFor,
} from './helpers/harness.mjs'

const protocol = await loadProtocolModule()

/** A ready frame shaped exactly like the engine's (`engine/Program.cs:ReadyFrame`). */
function readyFrame(overrides = {}) {
  return {
    type: 'ready',
    protocol: protocol.PROTOCOL_VERSION,
    engine: 'EngineeringGraph.Engine',
    runtime: '8.0.0',
    processArchitecture: 'x64',
    pid: 1234,
    operations: [...protocol.OPERATIONS],
    ...overrides,
  }
}

test('OPERATIONS is the engine catalog, in declaration order', () => {
  assert.deepEqual([...protocol.OPERATIONS], ['GetSchema', 'Ingest', 'Query', 'Update'])
  assert.equal(protocol.PROTOCOL_VERSION, 1)
  assert.equal(protocol.OPERATIONS.length, protocol.OPERATION_SET.size)

  assert.equal(protocol.isOperation('GetSchema'), true)
  assert.equal(protocol.isOperation('Ingest'), true)
  assert.equal(protocol.isOperation('Query'), true)
  assert.equal(protocol.isOperation('Update'), true)
  // The operation names are case sensitive on both sides (`OperationCatalog.IsAllowed`).
  assert.equal(protocol.isOperation('getSchema'), false)
  assert.equal(protocol.isOperation('update'), false)
  assert.equal(protocol.isOperation('Drop'), false)
  assert.equal(protocol.isOperation(''), false)
})

test('parseFrame accepts the three frame types and rejects everything else', () => {
  const ready = protocol.parseFrame(JSON.stringify(readyFrame()))
  assert.ok(protocol.isReadyFrame(ready), 'a ready frame must be recognised')
  assert.deepEqual([...protocol.operationsOf(ready)], [...protocol.OPERATIONS])

  const progress = protocol.parseFrame('{"type":"progress","id":"a","phase":"ingest","message":"Crawling"}')
  assert.ok(protocol.isProgressFrame(progress))
  assert.equal(progress.phase, 'ingest')

  const result = protocol.parseFrame('{"type":"result","protocol":1,"id":"a","ok":false,"durationMs":3,"error":{"code":"QUERY_REJECTED","message":"no"}}')
  assert.ok(protocol.isResultFrame(result))
  assert.equal(result.error.code, 'QUERY_REJECTED')

  // Stray output must be ignored, not mistaken for a frame: the .NET runtime and
  // a future engine version may write anything to stdout.
  assert.equal(protocol.parseFrame('EngineeringGraph.Engine: ready (protocol 1)'), null)
  assert.equal(protocol.parseFrame('{ not json'), null)
  assert.equal(protocol.parseFrame('[{"type":"ready"}]'), null)
  assert.equal(protocol.parseFrame('"ready"'), null)
  assert.equal(protocol.parseFrame('{"type":"log","message":"hello"}'), null, 'the engine has no log frame')
  assert.equal(protocol.parseFrame(''), null)

  // A ready frame whose operation list is malformed still parses; the list is
  // normalized so a comparison reports the difference instead of throwing.
  const broken = protocol.parseFrame('{"type":"ready","protocol":1,"pid":1}')
  assert.deepEqual(protocol.operationsOf(broken), [])
})

test('the ready frame announces exactly the OPERATIONS list, entry by entry', async (t) => {
  if (!engineAvailable) {
    t.skip(engineSkipReason)
    return
  }

  const logs = []
  const client = await engineClient({ logs })
  t.after(async () => {
    await client.stop()
  })

  const ready = await client.start()
  assert.equal(ready.protocol, protocol.PROTOCOL_VERSION)
  assert.deepEqual([...ready.operations], [...protocol.OPERATIONS], 'the plugin and the engine disagree about the catalog')
  assert.equal(ready.engine, 'EngineeringGraph.Engine')
  assert.ok(Number.isInteger(ready.pid) && ready.pid > 0, 'the ready frame must carry the engine pid')
  assert.ok(typeof ready.runtime === 'string' && ready.runtime.length > 0)
  assert.ok(ready.processArchitecture === 'x64' || ready.processArchitecture === 'x86')

  // The agreement above is the point: a disagreement is a warning, and this run
  // must not produce one.
  assert.deepEqual(logsAt(logs, 'warn'), [])

  const status = client.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.pid, ready.pid)
  assert.equal(status.exePathSource, 'config', 'the test passed an absolute enginePath')
  assert.deepEqual([...status.ready.operations], [...protocol.OPERATIONS])

  // The engine's human note goes to stderr, which is a separate stream: it may be
  // dispatched after the `ready` frame resolved, so it is waited for rather than
  // assumed. It must never appear as unexpected stdout.
  const notes = await waitFor(() => {
    const tail = client.status().stderrTail
    return tail.some((line) => line.includes('ready')) ? tail : null
  }, { what: 'the engine stderr note' })
  assert.ok(notes.every((line) => !line.startsWith('{')), 'stderr holds human notes, not frames')
  assert.deepEqual(client.status().unexpectedOutput, [], 'stdout carried frames only')

  await client.stop()
  assert.equal(client.status().pid, null, 'stop() must not leave the child behind')
  assert.equal(client.status().state, 'stopped')
  // Safe to call twice, and a later state check is not confused by the first call.
  await client.stop()
  assert.equal(client.status().pid, null)
})

test('a missing executable is a transport failure: it throws with the code first', async () => {
  const client = await engineClient({ enginePath: missingEnginePath() })

  let thrown
  try {
    await client.request('GetSchema', {})
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, 'a missing engine must throw, not resolve with ok:false')
  assert.equal(thrown.name, 'ToolFailure')
  assert.match(thrown.message, /^engine_not_found: /, 'the message must start with the stable code')
  assert.equal(thrown.code, 'engine_not_found')
  assert.equal(thrown.details.exePath, missingEnginePath())
  assert.equal(thrown.details.exePathSource, 'config')

  // The failure is recorded, so status() explains it without a retry.
  const status = client.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.lastError.code, 'engine_not_found')
  assert.equal(status.pid, null)

  await client.stop()
})

test('an already-aborted signal cancels the request and leaves the idle engine alone', async (t) => {
  if (!engineAvailable) {
    t.skip(engineSkipReason)
    return
  }

  const client = await engineClient()
  t.after(async () => {
    await client.stop()
  })

  const abort = new AbortController()
  abort.abort()

  let thrown
  try {
    await client.request('GetSchema', {}, { signal: abort.signal })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, 'a cancelled request must reject')
  assert.match(thrown.message, /^engine_cancelled: /)
  assert.equal(thrown.code, 'engine_cancelled')

  // Nothing was written to the engine, so it is still there (and idle): the
  // cancellation killed the request, not a healthy process.
  assert.equal(client.state, 'ready')
  assert.ok(client.status().pid !== null)
})
