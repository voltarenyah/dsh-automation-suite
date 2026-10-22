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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createTestContext, engineClient, loadPlugin, packageRoot } from './helpers/harness.mjs'

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

/** The two components `buildDeviceTree` exports, by the relative path the ledger records. */
const MAIN_RELATIVE = 'blocks/Main [OB1].xml'
const FC_RELATIVE = 'blocks/010_Cell/FC_LAD_SimulateCylinder_Call [FC1].xml'

/** Best-effort removal of a temp tree (no junction is involved, see the test above). */
function removeTempTree(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch {
    // deliberately ignored: a cleanup hiccup must not fail a passing test
  }
}

/** The provenance row for one component, read through node:sqlite rather than the plugin. */
function componentRows(dbPath, relativePath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const component = db
      .prepare('SELECT component_key AS key, content_hash AS hash FROM source_components WHERE relative_path = ?')
      .get(relativePath)
    const nodes =
      component === undefined
        ? 0
        : db.prepare('SELECT COUNT(*) AS n FROM source_component_nodes WHERE component_key = ?').get(component.key).n
    return { component, nodes }
  } finally {
    db.close()
  }
}

/** Rename the FC's first `Bool` input everywhere it appears (declaration and network use). */
function renameInterfaceMember(fcPath) {
  const original = readFileSync(fcPath, 'utf8')
  assert.ok(original.includes('"btn_forward"'), 'the fixture must still declare btn_forward')
  writeFileSync(fcPath, original.replaceAll('"btn_forward"', '"btn_forward_renamed"'), 'utf8')
}

test('an incremental update replaces one changed block and keeps the rest of the graph', async (t) => {
  const { service } = await applyAndGetService()
  if (!service.status().available) {
    t.skip('engine not built — run: pwsh -NoProfile -File engine/build.ps1')
    return
  }

  const { root, device } = buildDeviceTree()
  try {
    const ingest = await service.ingestDevice(device)
    assert.equal(ingest.ok, true, `ingest failed: ${JSON.stringify(ingest.error)}`)
    const dbPath = ingest.data.dbPath
    const sidecarPath = join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`)
    const sidecarBefore = JSON.parse(readFileSync(sidecarPath, 'utf8'))

    const before = componentRows(dbPath, FC_RELATIVE)
    const mainBefore = componentRows(dbPath, MAIN_RELATIVE)
    assert.ok(before.component, 'the ingest must record component provenance for the FC')
    assert.ok(mainBefore.nodes > 0, 'the caller must own nodes before the update')

    renameInterfaceMember(join(device, 'blocks', '010_Cell', 'FC_LAD_SimulateCylinder_Call [FC1].xml'))

    const outcome = await service.updateDevice(device, { changedPaths: [FC_RELATIVE] })
    assert.equal(outcome.ok, true, `update failed: ${JSON.stringify(outcome.error)}`)
    assert.equal(outcome.operation, 'Update')
    assert.equal(outcome.data.dbPath, dbPath, 'the update reports the database it wrote')
    assert.equal(outcome.data.changed, 1)
    assert.equal(outcome.data.removed, 0)
    assert.ok(outcome.data.closure >= 1, 'the calling block is re-imported as the dependency closure')
    assert.ok(
      outcome.data.closureComponents.includes(MAIN_RELATIVE),
      `the closure must name the caller: ${JSON.stringify(outcome.data.closureComponents)}`,
    )
    assert.ok(outcome.data.nodes > 0 && outcome.data.edges > 0, 'the graph totals are reported')

    // 1. The component's content hash changed, and only that component was replaced.
    const after = componentRows(dbPath, FC_RELATIVE)
    assert.notEqual(after.component.hash, before.component.hash, 'the content hash must change')
    assert.equal(after.component.key, before.component.key, 'a content change must not change the identity')

    // 2. The renamed member is in, the old one is out, and the caller's node count is
    //    untouched (it was re-imported, not rebuilt).
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const symbolCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(id).n
      assert.equal(symbolCount('symbol:btn_forward'), 0, 'the old symbol node must be gone')
      assert.equal(symbolCount('symbol:btn_forward_renamed'), 1, 'the renamed symbol node must exist')
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM source_components").get().n,
        2,
        'the other component must still be there',
      )
      const calls = db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE type = 'CALLS' AND from_node_id = 'block:Main' AND to_node_id = 'block:FC_LAD_SimulateCylinder_Call'",
        )
        .get().n
      assert.equal(calls, 1, "the closure re-import must keep Main's CALLS edge to the changed FC")
      // The derived tables were rebuilt, not left describing the pre-update graph.
      const networks = db.prepare("SELECT COUNT(*) AS n FROM knowledge_networks WHERE block_id = 'block:FC_LAD_SimulateCylinder_Call'").get().n
      assert.ok(networks > 0, 'the derived network table must describe the updated block')
    } finally {
      db.close()
    }
    assert.equal(componentRows(dbPath, MAIN_RELATIVE).nodes, mainBefore.nodes, "the caller's node count must not change")

    // 3. A successful update claims freshness through the same writer an ingest uses.
    const sidecarAfter = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    assert.equal(sidecarAfter.plcChecksum, PLC_CHECKSUM)
    assert.equal(sidecarAfter.device, DEVICE)
    assert.ok(sidecarAfter.builtAt >= sidecarBefore.builtAt, 'the update must refresh the sidecar timestamp')
  } finally {
    removeTempTree(root)
  }
})

test('an incremental update removes a deleted block and ignores a path it never imported', async (t) => {
  const { service } = await applyAndGetService()
  if (!service.status().available) {
    t.skip('engine not built — run: pwsh -NoProfile -File engine/build.ps1')
    return
  }

  const { root, device } = buildDeviceTree()
  try {
    const ingest = await service.ingestDevice(device)
    assert.equal(ingest.ok, true, `ingest failed: ${JSON.stringify(ingest.error)}`)
    const dbPath = ingest.data.dbPath
    const mainBefore = componentRows(dbPath, MAIN_RELATIVE)

    unlinkSync(join(device, 'blocks', '010_Cell', 'FC_LAD_SimulateCylinder_Call [FC1].xml'))
    const outcome = await service.updateDevice(device, {
      changedPaths: [],
      removedPaths: [FC_RELATIVE, 'blocks/NeverExported.xml'],
    })
    assert.equal(outcome.ok, true, `removal failed: ${JSON.stringify(outcome.error)}`)
    assert.equal(outcome.data.changed, 0)
    assert.equal(outcome.data.removed, 1, 'only the component the database knew is removed')
    assert.deepEqual(
      outcome.data.ignoredRemovedPaths,
      ['blocks/NeverExported.xml'],
      'a path the database never imported is reported, not refused',
    )

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM source_components WHERE relative_path = ?').get(FC_RELATIVE).n,
        0,
        'the removed component must leave no provenance row',
      )
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_components').get().n, 1)
    } finally {
      db.close()
    }
    assert.equal(componentRows(dbPath, MAIN_RELATIVE).nodes, mainBefore.nodes, "the survivor's node count must not change")
  } finally {
    removeTempTree(root)
  }
})

test('the incremental update refuses what it cannot prove safe, and changes nothing', async (t) => {
  const { service } = await applyAndGetService()
  if (!service.status().available) {
    t.skip('engine not built — run: pwsh -NoProfile -File engine/build.ps1')
    return
  }

  const { root, device } = buildDeviceTree()
  try {
    const ingest = await service.ingestDevice(device)
    assert.equal(ingest.ok, true, `ingest failed: ${JSON.stringify(ingest.error)}`)
    const dbPath = ingest.data.dbPath
    const sidecarPath = join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`)
    const sidecarBefore = readFileSync(sidecarPath, 'utf8')
    const hashBefore = componentRows(dbPath, FC_RELATIVE).component.hash

    // A path the database never imported is a refusal, never a guess at which
    // component the caller meant.
    const unknown = await service.updateDevice(device, { changedPaths: ['blocks/DoesNotExist.xml'] })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'UPDATE_UNKNOWN_COMPONENT')
    assert.match(unknown.error.details.remediation, /Ingest/)

    // A database without provenance cannot be updated in place; the consumer is told
    // to fall back to a full rebuild.
    const emptyDb = join(root, 'empty.db')
    writeFileSync(emptyDb, '')
    const rebuild = await service.updateDevice(device, { changedPaths: [FC_RELATIVE], dbPath: emptyDb })
    assert.equal(rebuild.ok, false)
    assert.equal(rebuild.error.code, 'UPDATE_REQUIRES_FULL_REBUILD')

    // The cap: the service deliberately does not expose it, so the raw client asks
    // for an update of two components with a limit of one.
    const client = await engineClient()
    try {
      const frame = await client.request('Update', {
        deviceDir: device,
        dbPath,
        changedPaths: [FC_RELATIVE, MAIN_RELATIVE],
        maxComponents: 1,
      })
      assert.equal(frame.ok, false)
      assert.equal(frame.error.code, 'UPDATE_TOO_LARGE')
      assert.match(frame.error.remediation, /Ingest/)
    } finally {
      await client.stop()
    }

    // Every refusal left the database and its sidecar exactly as they were.
    assert.equal(componentRows(dbPath, FC_RELATIVE).component.hash, hashBefore)
    assert.equal(readFileSync(sidecarPath, 'utf8'), sidecarBefore, 'a refused update must not touch the sidecar')
  } finally {
    removeTempTree(root)
  }
})

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
