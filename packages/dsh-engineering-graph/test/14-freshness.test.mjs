/**
 * Graph freshness: the ingest sidecar, the comparison rule, and the two entry
 * points that leave it behind.
 *
 * The point of this file is that freshness is **observable and factual**: a
 * successful ingest records the PLC checksum the export ledger names, and
 * `knowledge_workspace` compares that recorded checksum with the ledger's current
 * one. Four things are asserted, in the order the feature is built:
 *
 *   1. the path and the schema, derived from `deviceDir` alone (never `cwd`);
 *   2. the writer: atomic, overwriting, tolerant of a missing ledger, and never
 *      updating on a failed ingest;
 *   3. both entry points write it — the `knowledgeGraph` service and the
 *      `knowledge_ingest` tool;
 *   4. `knowledge_workspace` reports `fresh` / `stale` / `unknown` per device and
 *      renders the verdict, because the model never sees `data`.
 *
 * No engine is needed: the service and the tool are driven against a fake
 * `request`, which is exactly the seam both use. Test data lives in
 * `os.tmpdir()` and is removed afterwards.
 *
 * @module dsh-engineering-graph/test/freshness
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  createTestContext,
  executeTool,
  loadFreshnessModule,
  loadPlugin,
  loadToolsModule,
} from './helpers/harness.mjs'

const freshness = await loadFreshnessModule()
const plugin = await loadPlugin()
const tools = await loadToolsModule()

/** Roots created by this file, removed in one sweep at the end. */
const created = []
after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

/** A fresh temporary workspace root. */
function makeRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `graph-freshness-${label}-`))
  created.push(root)
  return root
}

/** A device directory inside a temp workspace. */
function makeDevice(root, device = 'Sino_PEI') {
  const deviceDir = join(root, 'source', device)
  mkdirSync(deviceDir, { recursive: true })
  return deviceDir
}

/** Write `_evidence.json`; `document === null` means "invalid JSON". */
function writeEvidence(deviceDir, document) {
  const text = document === null ? '{ this is not json' : `${JSON.stringify(document, undefined, 2)}\n`
  writeFileSync(join(deviceDir, '_evidence.json'), text, 'utf8')
}

/** The ledger as the export step writes it (only the fields this plugin reads). */
function evidenceDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'xml-norm-v1',
    device: 'Sino_PEI',
    software: 'Sino_PEI',
    plcChecksum: 'C0 01 C3 13 58 AC 0E 50',
    stateId: 'state-1',
    objects: {},
    ...overrides,
  }
}

/** The sidecar's JSON, read back from disk. */
function readSidecar(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** A fake engine reply that the service and the tool both accept. */
function resultFrame({ ok = true, data = null, error } = {}) {
  return {
    type: 'result',
    protocol: 1,
    ok,
    durationMs: 5,
    data,
    ...(error === undefined ? {} : { error }),
  }
}

/** A logger that only records warnings, for the sidecar's failure sink. */
function warningLog(warnings = []) {
  return {
    debug() {},
    info() {},
    warn(message) {
      warnings.push(message)
    },
    error() {},
  }
}

/** The context plugin's index, in the shape `create_engineering_project` writes. */
function writeIndex(root, devices) {
  mkdirSync(join(root, 'source'), { recursive: true })
  writeFileSync(
    join(root, 'source', '_dsh-engineering-context.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: { name: 'PEI_SinoARP_SWT2', savedAs: null },
        exportedAt: '2026-10-19T09:00:00.000Z',
        devices: devices.map((device) => ({
          device,
          software: device,
          directory: join(root, 'source', device),
          manifest: join(root, 'source', device, '_manifest.json'),
        })),
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  )
}

/** Create `knowledge/<device>/<device>_knowledge.db`. */
function writeDatabase(root, device) {
  const folder = join(root, 'knowledge', device)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${device}_knowledge.db`), 'x'.repeat(2048))
}

/** Exec context carrying the session working directory. */
const execWithCwd = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })

test('the sidecar path is derived from the device directory, two levels up, never from cwd', () => {
  const root = makeRoot('path')
  const deviceDir = join(root, 'source', 'Sino_PEI')

  assert.equal(freshness.workspaceRootOfDeviceDir(deviceDir), root)
  assert.equal(freshness.deviceNameOfDeviceDir(deviceDir), 'Sino_PEI')
  assert.equal(freshness.graphSidecarPath(deviceDir), join(root, '.dsh', 'local', 'graph', 'Sino_PEI.json'))
  assert.equal(freshness.graphSidecarPathIn(root, 'Sino_PEI'), freshness.graphSidecarPath(deviceDir))

  // A trailing separator is how readdir hands a directory over; it must not change
  // the answer.
  assert.equal(freshness.graphSidecarPath(`${deviceDir}\\`), join(root, '.dsh', 'local', 'graph', 'Sino_PEI.json'))
  assert.equal(freshness.graphSidecarPath(`${deviceDir}/`), join(root, '.dsh', 'local', 'graph', 'Sino_PEI.json'))
})

test('a device directory outside source/ gets no sidecar: the workspace root is never guessed', async () => {
  const root = makeRoot('guard')
  // An export folder that is not a project's `source/<device>`: two levels up is a
  // directory that happens to exist, not a workspace. Deriving blindly would put a
  // `.dsh/` at a drive root (or in a checkout), so the writer refuses.
  const outside = join(root, 'exports', 'PLC_1')
  mkdirSync(outside, { recursive: true })
  writeEvidence(outside, evidenceDocument())
  const warnings = []

  const document = await freshness.recordGraphSidecar(outside, { log: warningLog(warnings) })

  assert.equal(document, null)
  assert.equal(existsSync(join(root, '.dsh')), false, 'nothing may be written outside the documented project layout')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not <workspace>\/source\/<device>/u)
  assert.deepEqual(await freshness.readGraphFacts(outside), {
    graphChecksum: null,
    graphStateId: null,
    graphBuiltAt: null,
    graphFreshness: 'unknown',
  })
})

test('a successful ingest sidecar carries the schema version, the ledger checksum and the source dir', async () => {
  const root = makeRoot('write')
  const deviceDir = makeDevice(root)
  writeEvidence(deviceDir, evidenceDocument())

  const builtAt = new Date('2026-10-22T10:11:12.000Z')
  const document = await freshness.recordGraphSidecar(deviceDir, { now: builtAt })
  const expected = {
    schemaVersion: 1,
    device: 'Sino_PEI',
    plcChecksum: 'C0 01 C3 13 58 AC 0E 50',
    stateId: 'state-1',
    builtAt: '2026-10-22T10:11:12.000Z',
    sourceDir: 'source/Sino_PEI',
  }

  assert.deepEqual(document, expected, 'the writer returns exactly what it wrote')
  const path = freshness.graphSidecarPath(deviceDir)
  assert.equal(path, join(root, '.dsh', 'local', 'graph', 'Sino_PEI.json'))
  assert.deepEqual(readSidecar(path), expected)
  assert.deepEqual(await freshness.readGraphSidecar(path), expected)

  // Atomic means "no temporary file survives a successful write".
  assert.deepEqual(readdirSync(join(root, '.dsh', 'local', 'graph')), ['Sino_PEI.json'])

  // And the reader decides the verdict from both sides.
  assert.deepEqual(await freshness.readGraphFacts(deviceDir), {
    graphChecksum: 'C0 01 C3 13 58 AC 0E 50',
    graphStateId: 'state-1',
    graphBuiltAt: '2026-10-22T10:11:12.000Z',
    graphFreshness: 'fresh',
  })
})

test('a changed ledger makes the graph stale until the next ingest overwrites the sidecar', async () => {
  const root = makeRoot('overwrite')
  const deviceDir = makeDevice(root)
  writeEvidence(deviceDir, evidenceDocument())

  const first = await freshness.recordGraphSidecar(deviceDir, { now: new Date('2026-10-22T10:00:00.000Z') })
  assert.equal(first.plcChecksum, 'C0 01 C3 13 58 AC 0E 50')

  // The PLC changed: a new export rewrote the ledger.
  writeEvidence(deviceDir, evidenceDocument({ plcChecksum: 'AA BB CC', stateId: 'state-2' }))
  const stale = await freshness.readGraphFacts(deviceDir)
  assert.equal(stale.graphFreshness, 'stale', 'a differing checksum is the whole definition of stale')
  assert.equal(stale.graphChecksum, 'C0 01 C3 13 58 AC 0E 50', 'the report still states what the graph was built from')

  // Re-ingesting overwrites rather than appends; the temporary file never lingers.
  const rebuilt = await freshness.recordGraphSidecar(deviceDir, { now: new Date('2026-10-22T11:00:00.000Z') })
  assert.equal(rebuilt.plcChecksum, 'AA BB CC')
  assert.equal(rebuilt.stateId, 'state-2')
  assert.deepEqual(readSidecar(freshness.graphSidecarPath(deviceDir)), rebuilt)
  assert.deepEqual(readdirSync(join(root, '.dsh', 'local', 'graph')), ['Sino_PEI.json'])
  assert.deepEqual(await freshness.readGraphFacts(deviceDir), {
    graphChecksum: 'AA BB CC',
    graphStateId: 'state-2',
    graphBuiltAt: '2026-10-22T11:00:00.000Z',
    graphFreshness: 'fresh',
  })
})

test('a missing, corrupt or checksum-less ledger degrades to nulls instead of failing the ingest', async () => {
  const root = makeRoot('evidence')

  // No ledger at all: the graph is still buildable, it just cannot claim freshness.
  const bare = makeDevice(root, 'PLC_BARE')
  const bareDocument = await freshness.recordGraphSidecar(bare)
  assert.equal(bareDocument.plcChecksum, null)
  assert.equal(bareDocument.stateId, null)
  assert.equal((await freshness.readGraphFacts(bare)).graphFreshness, 'unknown')

  // Corrupt JSON.
  const corrupt = makeDevice(root, 'PLC_CORRUPT')
  writeEvidence(corrupt, null)
  const corruptDocument = await freshness.recordGraphSidecar(corrupt)
  assert.equal(corruptDocument.plcChecksum, null)
  assert.equal((await freshness.readGraphFacts(corrupt)).graphFreshness, 'unknown')

  // A checksum that is not a non-empty string is not a checksum.
  const wrong = makeDevice(root, 'PLC_WRONG')
  writeEvidence(wrong, evidenceDocument({ plcChecksum: 42, stateId: '   ' }))
  const wrongDocument = await freshness.recordGraphSidecar(wrong)
  assert.equal(wrongDocument.plcChecksum, null)
  assert.equal(wrongDocument.stateId, null)
  assert.equal((await freshness.readGraphFacts(wrong)).graphFreshness, 'unknown')

  // An unreadable sidecar (wrong schema version, not JSON, absent) is never a fresh claim.
  const path = freshness.graphSidecarPath(bare)
  writeFileSync(path, JSON.stringify({ ...bareDocument, schemaVersion: 2 }), 'utf8')
  assert.equal(await freshness.readGraphSidecar(path), null)
  writeFileSync(path, '{ truncated', 'utf8')
  assert.equal(await freshness.readGraphSidecar(path), null)
  unlinkSync(path)
  assert.equal(await freshness.readGraphSidecar(path), null)
  assert.equal((await freshness.readGraphFacts(bare)).graphFreshness, 'unknown')
  assert.equal((await freshness.readGraphFacts(null)).graphFreshness, 'unknown', 'a device with no source folder is unknown')
})

test('the freshness rule is checksum equality; anything missing is unknown, never fresh', () => {
  assert.equal(freshness.graphFreshness('AA', 'AA'), 'fresh')
  assert.equal(freshness.graphFreshness('AA', 'BB'), 'stale')
  assert.equal(freshness.graphFreshness(null, 'AA'), 'unknown')
  assert.equal(freshness.graphFreshness('AA', null), 'unknown')
  assert.equal(freshness.graphFreshness(null, null), 'unknown')
})

test('the knowledgeGraph service writes the sidecar after a successful ingest and never after a failed one', async () => {
  const root = makeRoot('service')
  const deviceDir = makeDevice(root)
  writeEvidence(deviceDir, evidenceDocument())
  const warnings = []
  const log = warningLog(warnings)
  const harness = createTestContext()

  let reply = resultFrame({
    data: {
      dbPath: join(root, 'knowledge', 'Sino_PEI', 'Sino_PEI_knowledge.db'),
      source: 'manifest',
      filesFound: 2,
      filesImported: 2,
      nodes: 3,
      edges: 1,
      byKind: { block: 2 },
      warnings: [],
    },
  })
  const service = new plugin.KnowledgeGraph(harness.ctx, { request: async () => reply, log }, '')

  const ok = await service.ingestDevice(deviceDir)
  assert.equal(ok.ok, true)
  const path = freshness.graphSidecarPath(deviceDir)
  assert.equal(existsSync(path), true, 'a successful ingest must leave the sidecar behind')
  const written = readSidecar(path)
  assert.equal(written.schemaVersion, 1)
  assert.equal(written.device, 'Sino_PEI')
  assert.equal(written.plcChecksum, 'C0 01 C3 13 58 AC 0E 50')
  assert.equal(written.stateId, 'state-1')

  // A failed ingest must leave the previous sidecar exactly as it was.
  const before = readFileSync(path, 'utf8')
  writeEvidence(deviceDir, evidenceDocument({ plcChecksum: 'DIFFERENT', stateId: 'state-2' }))
  reply = resultFrame({
    ok: false,
    error: { code: 'NO_SOURCE_FILES', message: 'nothing importable', remediation: 'export the blocks again' },
  })
  const failed = await service.ingestDevice(deviceDir)
  assert.equal(failed.ok, false)
  assert.equal(readFileSync(path, 'utf8'), before, 'a refused ingest must not rewrite the sidecar')
  const unchanged = readSidecar(path)
  assert.equal(unchanged.plcChecksum, 'C0 01 C3 13 58 AC 0E 50')
  assert.equal(unchanged.stateId, 'state-1')

  // A device that never ingested has no sidecar, whatever the engine said.
  const never = makeDevice(root, 'PLC_NEVER')
  const neverFailed = await service.ingestDevice(never)
  assert.equal(neverFailed.ok, false)
  assert.equal(existsSync(freshness.graphSidecarPath(never)), false)
  assert.deepEqual(warnings, [], 'a failed ingest is not a sidecar write failure')
})

test('knowledge_ingest writes the same sidecar as the service, from the tool surface', async () => {
  const root = makeRoot('tool-ingest')
  const deviceDir = makeDevice(root)
  writeEvidence(deviceDir, evidenceDocument({ plcChecksum: 'F1 F2 F3' }))

  const context = createTestContext()
  tools.registerTools(context.ctx, {
    request: async () =>
      resultFrame({
        data: {
          dbPath: join(root, 'knowledge', 'Sino_PEI', 'Sino_PEI_knowledge.db'),
          source: 'manifest',
          filesFound: 0,
          filesImported: 0,
          nodes: 0,
          edges: 0,
          byKind: {},
          warnings: [],
        },
      }),
    log: warningLog(),
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_ingest')
  const value = await executeTool(definition, { device_dir: deviceDir }, { signal: new AbortController().signal })

  assert.equal(value.ok, true)
  const path = freshness.graphSidecarPath(deviceDir)
  assert.equal(existsSync(path), true, 'the tool is the second entry point, so it must write the sidecar too')
  const written = readSidecar(path)
  assert.equal(written.schemaVersion, 1)
  assert.equal(written.device, 'Sino_PEI')
  assert.equal(written.plcChecksum, 'F1 F2 F3')
  assert.equal(written.sourceDir, 'source/Sino_PEI')
  assert.match(written.builtAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('knowledge_workspace reports fresh, stale and unknown per device, and renders the verdict', async () => {
  const root = makeRoot('workspace')
  const devices = ['PLC_FRESH', 'PLC_STALE', 'PLC_NO_SIDECAR', 'PLC_NO_EVIDENCE']
  for (const device of devices) {
    makeDevice(root, device)
    writeDatabase(root, device)
    writeEvidence(join(root, 'source', device), evidenceDocument())
  }

  // fresh: recorded at AA and the ledger still says AA (written below by the helper).
  await freshness.recordGraphSidecar(join(root, 'source', 'PLC_FRESH'))

  // stale: recorded at AA, then the ledger moved on to BB.
  await freshness.recordGraphSidecar(join(root, 'source', 'PLC_STALE'))
  writeEvidence(join(root, 'source', 'PLC_STALE'), evidenceDocument({ plcChecksum: 'BB' }))

  // unknown: a database that predates the sidecar.
  // (PLC_NO_SIDECAR is never ingested here.)

  // unknown: the sidecar exists but the ledger is gone.
  await freshness.recordGraphSidecar(join(root, 'source', 'PLC_NO_EVIDENCE'))
  unlinkSync(join(root, 'source', 'PLC_NO_EVIDENCE', '_evidence.json'))

  writeIndex(root, devices)

  const context = createTestContext()
  tools.registerTools(context.ctx, {
    request: async () => {
      throw new Error('knowledge_workspace must not need the engine')
    },
    log: warningLog(),
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_workspace')
  const value = await executeTool(definition, {}, execWithCwd(root))

  assert.equal(value.ok, true)
  assert.deepEqual(value.warnings, [])

  const byDevice = new Map(value.data.devices.map((device) => [device.device, device]))
  assert.deepEqual(
    [...byDevice.values()].map((device) => [device.device, device.graphFreshness]),
    [
      ['PLC_FRESH', 'fresh'],
      ['PLC_NO_EVIDENCE', 'unknown'],
      ['PLC_NO_SIDECAR', 'unknown'],
      ['PLC_STALE', 'stale'],
    ],
  )

  const fresh = byDevice.get('PLC_FRESH')
  assert.equal(fresh.graphChecksum, 'C0 01 C3 13 58 AC 0E 50')
  assert.equal(fresh.graphStateId, 'state-1')
  assert.match(fresh.graphBuiltAt, /^\d{4}-\d{2}-\d{2}T/)
  // The fields that were already there keep their shape and stay first.
  assert.equal(fresh.databaseExists, true)
  assert.equal(fresh.bytes, 2048)
  assert.equal(fresh.origin, 'index')
  assert.equal(fresh.deviceDir, 'source/PLC_FRESH')

  assert.equal(byDevice.get('PLC_STALE').graphChecksum, 'C0 01 C3 13 58 AC 0E 50')
  assert.equal(byDevice.get('PLC_NO_SIDECAR').graphChecksum, null)
  assert.equal(byDevice.get('PLC_NO_SIDECAR').graphBuiltAt, null)
  assert.equal(byDevice.get('PLC_NO_EVIDENCE').graphChecksum, 'C0 01 C3 13 58 AC 0E 50')
  assert.equal(byDevice.get('PLC_NO_EVIDENCE').graphFreshness, 'unknown')

  const details = value.details.join('\n')
  assert.match(details, /PLC_FRESH: .*graph: fresh/u)
  assert.match(details, /PLC_STALE: .*graph: STALE \(built \d{4}-\d{2}-\d{2}T.*C0 01 C3 13 58 AC 0E 50\)/u)
  assert.match(details, /PLC_NO_SIDECAR: .*graph: unknown/u)
  assert.match(details, /PLC_NO_EVIDENCE: .*graph: unknown/u)
  assert.match(details, /Graph freshness: 1 device\(s\) changed since its knowledge database was built \(PLC_STALE\); rebuild with knowledge_ingest/u)
})
