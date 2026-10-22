/**
 * The manifest path and the `knowledgeGraph` service, in one file.
 *
 * Why this file exists: every other test drives the **crawl fallback**, because the
 * fixtures are flat — no manifest, no `blocks/`-style category directories. The path
 * real exports actually take (family 1's `_manifest.json` under the D24
 * layout) had **no automated coverage at all**, so a regression there would have gone
 * unnoticed while the suite stayed green. That is exactly how the earlier "a
 * cross-group CALLS edge points at a placeholder" defect survived.
 *
 * It goes through the service rather than the tool on purpose: that is the seam
 * family 2 will call, so the same test proves the service is registered, that it
 * shares the tools' conversion, that the manifest path is correct, and that a
 * successful ingest records the freshness sidecar from the device's ledger
 * (`src/graph-freshness.ts`).
 *
 * Engine-dependent assertions skip with the build command when the engine is absent
 * (it is a build artefact even though it is committed — see `engine/build.ps1`).
 *
 * @module dsh-engineering-graph/test/service-and-manifest
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createTestContext, loadPlugin, packageRoot } from './helpers/harness.mjs'

const FIXTURES = join(packageRoot, 'engine', 'fixtures')
const DEVICE = 'Sino_PEI'

/**
 * Every applied plugin, unloaded before the runner exits. pply owns the engine
 * subprocess through an effect, so leaving it loaded would keep the child (and the
 * event loop) alive and hang the suite instead of failing it.
 */
const teardowns = []

after(async () => {
  for (const unload of teardowns.reverse()) await unload()
})

/**
 * The PLC checksum the export ledger records. It is what the freshness sidecar
 * must carry, so it is spelled once here and compared in the ingest test.
 */
const PLC_CHECKSUM = 'C0 01 C3 13 58 AC 0E 50'

/** Build a device tree in the D24 shape, with a manifest covering two blocks in two groups. */
function buildDeviceTree() {
  const root = mkdtempSync(join(tmpdir(), 'graph-manifest-'))
  const device = join(root, 'source', DEVICE)
  mkdirSync(join(device, 'blocks', '010_Cell'), { recursive: true })
  mkdirSync(join(device, 'types'), { recursive: true })
  mkdirSync(join(device, 'tag_tables'), { recursive: true })
  copyFileSync(join(FIXTURES, 'Main [OB1].xml'), join(device, 'blocks', 'Main [OB1].xml'))
  copyFileSync(
    join(FIXTURES, 'FC_LAD_SimulateCylinder_Call [FC1].xml'),
    join(device, 'blocks', '010_Cell', 'FC_LAD_SimulateCylinder_Call [FC1].xml'),
  )

  // The export ledger family 1 writes next to the manifest. Only the two fields the
  // freshness sidecar borrows matter here.
  writeFileSync(
    join(device, '_evidence.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        hashAlgo: 'xml-norm-v1',
        device: DEVICE,
        software: DEVICE,
        plcChecksum: PLC_CHECKSUM,
        stateId: 'state-manifest-1',
        objects: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // Family 1's own shape, including the three documented-but-absent fields this
  // importer must tolerate: no `counts`, no `objectCount`, and `group` missing for
  // root-group objects (not an empty string).
  writeFileSync(
    join(device, '_manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        protocol: 1,
        generatedBy: 'TiaOpennessV17Min.Controller',
        device: DEVICE,
        software: DEVICE,
        outputDir: device,
        failureCount: 1,
        blocks: [
          {
            category: 'blocks',
            name: 'Main',
            file: join(device, 'blocks', 'Main [OB1].xml'),
            simaticType: 'OB',
          },
          {
            category: 'blocks',
            name: 'FC_LAD_SimulateCylinder_Call',
            group: '010_Cell/',
            file: join(device, 'blocks', '010_Cell', 'FC_LAD_SimulateCylinder_Call [FC1].xml'),
            simaticType: 'FC',
          },
        ],
        failures: [
          {
            category: 'blocks',
            name: 'FOB_SAFETY',
            group: '000_SAFETY_TASK/',
            code: 'export_failed',
            message: 'The export of block is not permitted.',
          },
        ],
      },
      null,
      2,
    ),
  )
  return { root, device }
}

/** Apply the plugin on a stand-in context and hand back its service. */
async function applyAndGetService() {
  const harness = createTestContext()
  const plugin = await loadPlugin()
  plugin.apply(harness.ctx, {})
  teardowns.push(harness.unload)
  return { ...harness, plugin, service: harness.ctx.get('knowledgeGraph') }
}

test('the service is registered under the name the consumer looks up', async () => {
  const { service, plugin } = await applyAndGetService()
  assert.ok(service, 'knowledgeGraph was not registered')
  assert.equal(service.name, 'knowledgeGraph')
  assert.equal(plugin.KNOWLEDGE_GRAPH_SERVICE, 'knowledgeGraph')

  const status = service.status()
  assert.equal(typeof status.enginePath, 'string')
  assert.equal(typeof status.engineExists, 'boolean')
  assert.equal(status.available, status.engineExists)
  // The convention is stated by the service so a caller never re-derives it.
  assert.match(status.databaseConvention, /knowledge\/<device>\/<device>_knowledge\.db/)
})

test('a missing device directory is a coded failure, not a throw', async (t) => {
  const { service } = await applyAndGetService()
  if (!service.status().available) {
    t.skip('engine not built — run: pwsh -NoProfile -File engine/build.ps1')
    return
  }
  const outcome = await service.ingestDevice(join(packageRoot, 'test', 'does-not-exist'))
  assert.equal(outcome.ok, false, 'a missing device directory must not look like success')
  assert.equal(outcome.error?.code, 'DEVICE_DIR_NOT_FOUND')
})

test('a D24 device tree ingests from its manifest', async (t) => {
  const { service } = await applyAndGetService()
  if (!service.status().available) {
    t.skip('engine not built — run: pwsh -NoProfile -File engine/build.ps1')
    return
  }

  const { root, device } = buildDeviceTree()
  try {
    const outcome = await service.ingestDevice(device)
    assert.equal(outcome.ok, true, `ingest failed: ${JSON.stringify(outcome.error)}`)
    assert.equal(outcome.operation, 'Ingest')

    const data = outcome.data
    // 1. The manifest drove it, not a directory scan.
    assert.equal(data.source, 'manifest')
    assert.equal(data.device, DEVICE)
    assert.equal(data.filesImported, 2)

    // 2. The database landed on the agreed convention (D20): two levels up from the
    //    device directory, then knowledge/<device>/<device>_knowledge.db.
    const expectedDb = join(root, 'knowledge', DEVICE, `${DEVICE}_knowledge.db`)
    assert.equal(data.dbPath, expectedDb)

    // 2b. A successful ingest records its provenance in the workspace's local state
    //     (`.dsh/local/`, never committed), derived from the device directory rather
    //     than from the process cwd, and carrying the ledger's PLC checksum verbatim.
    const sidecarPath = join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`)
    assert.equal(existsSync(sidecarPath), true, 'a successful ingest must leave the freshness sidecar behind')
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    assert.equal(sidecar.schemaVersion, 1)
    assert.equal(sidecar.device, DEVICE)
    assert.equal(sidecar.plcChecksum, PLC_CHECKSUM, 'the sidecar must carry the evidence ledger checksum')
    assert.equal(sidecar.stateId, 'state-manifest-1')
    assert.equal(sidecar.sourceDir, `source/${DEVICE}`)
    assert.match(sidecar.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    // 3. The manifest's failures are surfaced, never dropped.
    assert.ok(
      data.warnings.some((line) => line.includes('FOB_SAFETY')),
      `the failure entry did not reach warnings: ${JSON.stringify(data.warnings)}`,
    )

    // 4. What the graph actually contains. Read with node:sqlite rather than through
    //    the plugin, so the check is independent of the code that wrote it.
    const db = new DatabaseSync(expectedDb, { readOnly: true })
    try {
      const polluted = db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_nodes WHERE id LIKE 'blocks/%' OR id LIKE 'types/%' OR id LIKE 'tag_tables/%'",
        )
        .get().n
      assert.equal(polluted, 0, 'ids must carry no category prefix')

      const folder = db
        .prepare(
          "SELECT p.value AS v FROM graph_nodes n JOIN graph_node_properties p ON p.node_id = n.id AND p.name = 'folderPath' WHERE n.id = 'block:FC_LAD_SimulateCylinder_Call'",
        )
        .get()
      assert.equal(folder?.v, '010_Cell', 'folderPath must be the clean user-group path')

      // The defect this file was written to guard: Main is in the root group and the
      // FC is one group down, so a device taken from a directory name would make the
      // caller compute a different id and land on a "not exported" placeholder.
      const calls = db
        .prepare(
          "SELECT t.kind AS kind, t.name AS name, COALESCE(r.value, '') AS placeholder FROM graph_edges e JOIN graph_nodes t ON t.id = e.to_node_id LEFT JOIN graph_node_properties r ON r.node_id = t.id AND r.name = 'declaredByReference' WHERE e.type = 'CALLS' AND e.from_node_id = 'block:Main'",
        )
        .all()
      assert.ok(calls.length > 0, 'Main should call something')
      for (const call of calls) {
        assert.equal(call.placeholder, '', `CALLS target ${call.name} is a placeholder, not the real block`)
        assert.equal(call.kind, 'FC')
      }
    } finally {
      db.close()
    }
  } finally {
    // Windows can still hold a transient lock on a file the engine just wrote (indexer,
    // antivirus), and `maxRetries` is the documented answer to that. A cleanup hiccup must
    // never fail a test whose assertions passed, so this stays best-effort: the directory
    // is under the OS temp directory either way.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // deliberately ignored
    }
  }
})
