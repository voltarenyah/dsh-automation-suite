/**
 * The `knowledgeGraph` seam, driven directly with stand-in services.
 *
 * What is asserted is the part of the workflow contract that the tool-level suite
 * cannot reach cheaply: an absent plugin and an engine that is not built are
 * **states**, an operation failure is data, a transport failure degrades to "the
 * graph was not built" without stopping the remaining devices, and a drifted
 * service shape never turns into a plausible-looking success.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTestContext, loadKnowledgeGraphModule } from './helpers/harness.mjs'

const { ingestKnowledgeGraph, knowledgeGraph, KNOWLEDGE_GRAPH_SERVICE } = await loadKnowledgeGraphModule()

const ROOT = join('C:', 'ws')
const DEVICES = [
  { device: 'PLC_1', directory: join(ROOT, 'source', 'PLC_1') },
  { device: 'PLC_2', directory: join(ROOT, 'source', 'PLC_2') },
]

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/** A stand-in `knowledgeGraph` service that records every call in order. */
function fakeGraph(options = {}) {
  const calls = []
  const service = {
    status() {
      calls.push({ operation: 'status' })
      if (options.statusThrows !== undefined) throw options.statusThrows
      return (
        options.status ?? {
          available: true,
          reason: null,
          enginePath: 'C:\\engine\\EngineeringGraph.Engine.exe',
          engineExists: true,
          source: 'package',
          databaseConvention: '<project root>/knowledge/<device>/<device>_knowledge.db',
        }
      )
    },
    async ingestDevice(deviceDir, request = {}) {
      calls.push({ operation: 'ingestDevice', deviceDir, options: request })
      if (options.ingestThrows !== undefined) throw options.ingestThrows
      // `rawIngest` is the "return exactly this, even undefined/nonsense" switch;
      // the `ingest` callback returning undefined means "use the healthy default".
      if ('rawIngest' in options) return options.rawIngest
      const reply = options.ingest?.(deviceDir, request)
      if (reply !== undefined) return reply
      const device = deviceDir.split(/[\\/]/u).pop()
      const dbPath = join(ROOT, 'knowledge', device, `${device}_knowledge.db`)
      return {
        ok: true,
        operation: 'Ingest',
        dryRun: false,
        summary: `Ingested 2 of 2 file(s) into ${dbPath}.`,
        data: { device, dbPath, source: 'manifest', filesFound: 2, filesImported: 2, nodes: 72, edges: 153, byKind: { block: 3 }, warnings: [] },
        changes: [],
        diagnostics: [],
        error: null,
        durationMs: 1200,
      }
    },
  }
  return { service, calls }
}

/** Run the step against a composition that has (or has not) the service. */
async function run(services, devices = DEVICES, options = {}) {
  const { ctx } = createTestContext({ services })
  return await ingestKnowledgeGraph({ ctx, log: logger(), root: ROOT, devices, ...options })
}

const okStatus = {
  available: true,
  reason: null,
  enginePath: 'C:\\engine\\EngineeringGraph.Engine.exe',
  engineExists: true,
  source: 'package',
  databaseConvention: '<project root>/knowledge/<device>/<device>_knowledge.db',
}

test('the service is found by name, and a malformed one counts as absent', () => {
  const { ctx } = createTestContext({ services: { [KNOWLEDGE_GRAPH_SERVICE]: { status() {}, ingestDevice() {} } } })
  assert.ok(knowledgeGraph(ctx))

  for (const malformed of [null, 'nope', {}, { status() {} }, { ingestDevice() {} }, { status: 1, ingestDevice: 2 }]) {
    const stand = createTestContext({ services: { [KNOWLEDGE_GRAPH_SERVICE]: malformed } })
    assert.equal(knowledgeGraph(stand.ctx), undefined, `a drifted service must read as absent: ${JSON.stringify(malformed)}`)
  }
})

test('no service at all: the graph is reported as not built, never as a failure', async () => {
  const report = await run({})
  assert.equal(report.state, 'absent')
  assert.equal(report.available, false)
  assert.deepEqual(report.notAttempted, ['PLC_1', 'PLC_2'])
  assert.deepEqual(report.totals, { devices: 2, ok: 0, filesFound: 0, filesImported: 0, nodes: 0, edges: 0 })
  assert.equal(report.details.length, 1)
  assert.match(report.details[0], /^Knowledge graph: not built/u)
  assert.match(report.warnings[0], /knowledgeGraph service/u)
})

test('an engine that is not built is a state: nothing is attempted', async () => {
  const graph = fakeGraph({ status: { ...okStatus, available: false, engineExists: false, reason: 'the knowledge engine was not found at X' } })
  const report = await run({ knowledgeGraph: graph.service })

  assert.equal(report.state, 'unavailable')
  assert.equal(report.reason, 'the knowledge engine was not found at X')
  assert.deepEqual(report.notAttempted, ['PLC_1', 'PLC_2'])
  assert.deepEqual(
    graph.calls.map((call) => call.operation),
    ['status'],
    'an unavailable engine is never asked to ingest',
  )
  assert.equal(report.details.length, 1)
  assert.match(report.details[0], /not built — the knowledge engine was not found at X/u)
  assert.match(report.warnings[0], /not built/u)
})

test('a status() that throws degrades the same way, and is never assumed available', async () => {
  const graph = fakeGraph({ statusThrows: new Error('boom') })
  const report = await run({ knowledgeGraph: graph.service })
  assert.equal(report.state, 'unavailable')
  assert.match(report.reason, /boom/u)
  assert.deepEqual(graph.calls.map((call) => call.operation), ['status'])
})

test('one call per device, in order, with the device directory and no dbPath override', async () => {
  const graph = fakeGraph()
  const report = await run({ knowledgeGraph: graph.service })

  assert.equal(report.state, 'ingested')
  assert.deepEqual(
    graph.calls.map((call) => (call.operation === 'status' ? 'status' : call.deviceDir)),
    ['status', DEVICES[0].directory, DEVICES[1].directory],
  )
  for (const call of graph.calls.filter((entry) => entry.operation === 'ingestDevice')) {
    assert.equal(call.options.dbPath, undefined, 'the service owns the database convention; the workflow must not pass one')
  }
  assert.equal(report.totals.devices, 2)
  assert.equal(report.totals.ok, 2)
  assert.equal(report.totals.filesImported, 4)
  assert.equal(report.totals.nodes, 144)
  assert.equal(report.totals.edges, 306)
  assert.equal(report.devices[0].dbPath, join(ROOT, 'knowledge', 'PLC_1', 'PLC_1_knowledge.db'))
  assert.match(report.details[0], /Knowledge graph: PLC_1 → knowledge\/PLC_1\/PLC_1_knowledge\.db/u)
  assert.match(report.details[0], /72 node\(s\) and 153 edge\(s\)/u)
})

test('an operation failure is data: the code, the message and the remediation all survive', async () => {
  const graph = fakeGraph({
    ingest: (deviceDir) =>
      deviceDir.endsWith('PLC_1')
        ? {
            ok: false,
            operation: 'Ingest',
            dryRun: false,
            summary: 'Ingest was refused.',
            data: null,
            changes: [],
            diagnostics: [],
            error: { code: 'MANIFEST_INVALID', message: 'the manifest is not valid JSON', details: { remediation: 're-export the device' } },
            durationMs: 3,
          }
        : undefined,
  })
  const report = await run({ knowledgeGraph: graph.service })

  assert.equal(report.state, 'partial')
  assert.equal(report.totals.ok, 1)
  const failed = report.devices[0]
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'MANIFEST_INVALID')
  assert.equal(failed.error.remediation, 're-export the device')
  assert.match(report.details[0], /PLC_1 — not built: MANIFEST_INVALID the manifest is not valid JSON \(re-export the device\)/u)
  assert.ok(report.warnings.some((warning) => /MANIFEST_INVALID/u.test(warning) && /re-export the device/u.test(warning)))
})

test('a transport failure degrades the graph and stops attempting devices', async () => {
  const graph = fakeGraph({ ingestThrows: new Error('engine_timeout: the engine did not answer') })
  const report = await run({ knowledgeGraph: graph.service })

  assert.equal(report.state, 'unavailable')
  assert.equal(report.available, false)
  assert.match(report.reason, /engine_timeout/u)
  assert.deepEqual(report.devices.map((entry) => entry.device), ['PLC_1'])
  assert.equal(report.devices[0].error.code, 'knowledge_engine_unreachable')
  assert.deepEqual(report.notAttempted, ['PLC_2'])
  assert.match(report.details.at(-1), /not attempted for 1 device/u)
  assert.ok(report.warnings.some((warning) => /not built|incomplete/u.test(warning)))
})

test('a transport failure after one success is partial, not a lost graph', async () => {
  const graph = fakeGraph({
    ingest: (deviceDir) => {
      if (deviceDir.endsWith('PLC_2')) throw new Error('engine_exited')
      return undefined
    },
  })
  const report = await run({ knowledgeGraph: graph.service })
  assert.equal(report.state, 'partial')
  assert.equal(report.totals.ok, 1)
  assert.deepEqual(report.notAttempted, [])
  assert.ok(report.warnings.some((warning) => /incomplete/u.test(warning)))
})

test('a drifted envelope never looks like a success', async () => {
  for (const reply of [undefined, null, 'nope', {}, { ok: true, data: 'not an object' }, { ok: 'yes', data: {} }]) {
    const graph = fakeGraph({ rawIngest: reply })
    const report = await run({ knowledgeGraph: graph.service }, [DEVICES[0]])
    assert.equal(report.devices[0].ok, false, `reply ${JSON.stringify(reply)} must not read as success`)
    assert.equal(report.devices[0].nodes, 0)
    assert.equal(report.state, 'failed')
  }
})

test('the engine`s manifest warnings become workflow diagnostics, capped', async () => {
  const warnings = Array.from({ length: 14 }, (_, index) => `object ${index} was refused`)
  const graph = fakeGraph({
    ingest: () => ({
      ok: true,
      operation: 'Ingest',
      dryRun: false,
      summary: 'Ingested.',
      data: { dbPath: join(ROOT, 'knowledge', 'PLC_1', 'PLC_1_knowledge.db'), filesFound: 2, filesImported: 2, nodes: 1, edges: 1, warnings },
      changes: [],
      diagnostics: [],
      error: null,
      durationMs: 1,
    }),
  })
  const report = await run({ knowledgeGraph: graph.service }, [DEVICES[0]])

  const notes = report.warnings.filter((warning) => warning.startsWith('Knowledge graph (PLC_1):'))
  assert.equal(notes.length, 10)
  assert.match(notes[0], /object 0 was refused/u)
  assert.ok(report.warnings.some((warning) => /4 more knowledge-graph warning/u.test(warning)))
  assert.equal(report.devices[0].warnings.length, 14, 'the payload keeps the full list')
})

test('no device directories is a state, not a failure', async () => {
  const graph = fakeGraph()
  const report = await run({ knowledgeGraph: graph.service }, [])
  assert.equal(report.state, 'empty')
  assert.deepEqual(graph.calls.map((call) => call.operation), ['status'])
  assert.match(report.details.at(-1), /nothing to ingest/u)
})

test('a cancelled call is rethrown, never reported as a finished workflow', async () => {
  const controller = new AbortController()
  const graph = fakeGraph({
    ingestThrows: new Error('engine_cancelled'),
  })
  controller.abort()
  await assert.rejects(
    run({ knowledgeGraph: graph.service }, [DEVICES[0]], { signal: controller.signal }),
    /engine_cancelled/u,
  )
})
