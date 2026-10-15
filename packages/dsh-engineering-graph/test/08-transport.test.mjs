/**
 * The transport failures, on purpose.
 *
 * A *working* engine never produces these, so they cannot be tested against
 * `engine/bin/EngineeringGraph.Engine.exe` — they are tested against the
 * deliberately broken peer in `test/helpers/stub-engine.mjs` instead, which is
 * what the client's documented `launchArgs` seam exists for. Each test asserts the
 * same contract the tools rely on:
 *
 * - the promise **rejects**, and the message starts with the stable code;
 * - `status()` explains the failure without a retry;
 * - nothing is left running: the client either keeps a healthy peer or reaps the
 *   broken one, but never leaks it.
 *
 * @module dsh-engineering-graph/test/transport
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { processAlive, stubEngineClient, waitFor } from './helpers/harness.mjs'

/**
 * Runs one request that must fail and returns the thrown error.
 *
 * Written out rather than using `assert.rejects` so the error's `code`, `details`
 * and message prefix can all be inspected at once.
 */
async function rejectOf(client, operation = 'GetSchema', params = {}, options = undefined) {
  try {
    await client.request(operation, params, options)
  } catch (error) {
    return error
  }
  throw new Error('the request was expected to fail, but it resolved')
}

test('a healthy stub behaves like the engine (the failure tests mean something)', async (t) => {
  const client = await stubEngineClient('ready')
  t.after(async () => {
    await client.stop()
  })

  const ready = await client.start()
  assert.equal(ready.protocol, 1)
  assert.deepEqual([...ready.operations], ['GetSchema', 'Ingest', 'Query'])

  const frame = await client.request('Query', { sql: 'SELECT 1' })
  assert.equal(frame.ok, true)
  assert.equal(frame.operation, 'Query')
  assert.deepEqual(frame.data.params, { sql: 'SELECT 1' })

  // The stub is a real child process with a real stdin: stopping it closes stdin,
  // the stub reads EOF and exits.
  const pid = client.status().pid
  assert.ok(processAlive(pid))
  await client.stop()
  await waitFor(() => !processAlive(pid), { what: 'the stub to exit' })
  assert.equal(client.status().pid, null)
})

test('a protocol mismatch throws engine_protocol_mismatch and reaps the peer', async () => {
  const client = await stubEngineClient('mismatch')

  const error = await rejectOf(client)
  assert.equal(error.name, 'ToolFailure')
  assert.match(error.message, /^engine_protocol_mismatch: /)
  assert.equal(error.code, 'engine_protocol_mismatch')
  assert.equal(error.details.engineProtocol, 2)
  assert.equal(error.details.pluginProtocol, 1)

  // A peer that speaks another protocol is not adopted: it is killed, and the
  // failure is recorded.
  const status = client.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.pid, null)
  assert.equal(status.lastError.code, 'engine_protocol_mismatch')
  await client.stop()
})

test('a silent handshake throws engine_handshake_timeout with the captured stderr', async () => {
  const client = await stubEngineClient('silent', { startupTimeoutMs: 400 })

  const error = await rejectOf(client)
  assert.match(error.message, /^engine_handshake_timeout: /)
  assert.equal(error.code, 'engine_handshake_timeout')
  assert.ok(Array.isArray(error.details.stderr))
  assert.equal(client.status().state, 'failed')
  assert.equal(client.status().pid, null)
  await client.stop()
})

test('a request that is never answered throws engine_timeout and terminates the peer', async (t) => {
  const client = await stubEngineClient('stall', { requestTimeoutMs: 400, startupTimeoutMs: 5_000 })
  t.after(async () => {
    await client.stop()
  })

  // The handshake succeeds; only the operation is stalled.
  await client.start()
  const pid = client.status().pid
  assert.ok(processAlive(pid))

  const error = await rejectOf(client)
  assert.match(error.message, /^engine_timeout: /)
  assert.equal(error.code, 'engine_timeout')
  assert.equal(error.details.operation, 'GetSchema')
  assert.equal(error.details.timeoutMs, 400)
  assert.equal(error.details.pid, pid)

  // An engine operation cannot be interrupted, so the client kills the process
  // (documented behaviour) and records why. The OS reaps the process before Node
  // dispatches the child's `exit` event, so the assertion waits for the client's
  // own view — that is the guarantee that matters: it forgets the handle.
  await waitFor(() => !processAlive(pid), { what: 'the stalled peer to be terminated' })
  await waitFor(() => client.status().pid === null, { what: 'the client to reap the stalled peer' })
  assert.equal(client.status().state, 'failed')
  assert.match(client.status().lastError.code, /^engine_(timeout|exited)$/)
})

test('a peer that dies mid-request throws engine_exited, not a timeout', async (t) => {
  const client = await stubEngineClient('die', { requestTimeoutMs: 10_000, startupTimeoutMs: 5_000 })
  t.after(async () => {
    await client.stop()
  })

  await client.start()
  const error = await rejectOf(client)
  assert.match(error.message, /^engine_exited: /)
  assert.equal(error.code, 'engine_exited')
  assert.equal(error.details.code, 3, 'the stub exits with code 3')
  assert.equal(error.details.signal, null)
  assert.equal(error.details.servedOperations, 0, 'the request never got an answer')

  const status = client.status()
  assert.equal(status.state, 'failed')
  assert.equal(status.pid, null)
  assert.equal(status.restarts, 1, 'an abandoned request counts as a restart')
  assert.ok(status.lastError.message.startsWith('engine_exited'))
})

test('a peer that forgot an operation is a warning, not a failure', async (t) => {
  const logs = []
  const client = await stubEngineClient('unknown-operations', { logs })
  t.after(async () => {
    await client.stop()
  })

  const ready = await client.start()
  assert.deepEqual([...ready.operations], ['GetSchema'], 'the stub really announces the short list')

  const warnings = logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].message.includes('out of sync'))

  // The three operations this plugin sends are still usable: a newer or older peer
  // that disagrees about the catalog is not a reason to refuse to work.
  const frame = await client.request('Query', { sql: 'SELECT 1' })
  assert.equal(frame.ok, true)
})
