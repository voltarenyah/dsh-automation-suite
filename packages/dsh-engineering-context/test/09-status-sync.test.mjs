/**
 * `project_status` and `project_sync`: the read-only state report, the plan
 * (default) and the real TIA → STAGE → SOURCE → git run.
 *
 * The interface plugin is a fake, because the controller cannot run here; the
 * workspace, the git repository and the STAGE files are real, because those are
 * exactly what the two tools are responsible for writing.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadChecksumCacheModule,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { toolDefinitions } = await loadToolsModule()
const { resolveConfig } = await loadConfigModule()
const { CHECKSUM_TTL_MS, checksumCacheKey, clearChecksumCache, readCachedChecksum, writeCachedChecksum } =
  await loadChecksumCacheModule()
const execFileAsync = promisify(execFile)

// The cache is module-level in-memory state, so one test must not inherit
// another's warm entry (each test has its own workspace root, but clearing is
// cheaper to reason about than relying on that).
beforeEach(() => {
  clearChecksumCache()
})

const STATUS = 'project_status'
const SYNC = 'project_sync'
const DEVICE = 'PLC1'
const SOFTWARE = 'SW1'

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
}

async function gitWorkspace(t) {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Engineering Context Test'])
  return root
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sessionReport(overrides = {}) {
  return {
    running: true,
    projectOpen: true,
    projectName: 'PEI_SinoARP',
    projectPath: 'C:\\TIA\\PEI_SinoARP.ap17',
    isModified: false,
    software: [{ device: DEVICE, software: SOFTWARE, blockCount: 3 }],
    reason: null,
    ...overrides,
  }
}

function checksumReport(checksum, options = {}) {
  if (options.unavailable === true) {
    return {
      ok: false,
      summary: 'the PLC has no compiled checksum',
      error: { code: 'checksum_unavailable', message: 'compile the PLC first' },
    }
  }
  return { ok: true, summary: 'checksum read', data: { checksum, device: DEVICE, software: SOFTWARE } }
}

function scanReport(query, overrides = {}) {
  const counts = { blocks: 1, types: 0, tagTables: 0, changed: 1, added: 0, removed: 0, unexportable: 0 }
  return {
    ok: true,
    summary: 'scan complete',
    data: {
      checksum: 'BB',
      unchanged: false,
      manifestRebuilt: true,
      counts,
      changed: [{ key: 'block||FB1', category: 'block', name: 'FB1', group: '010', faces: ['Code'] }],
      added: [],
      removed: [],
      unexportable: [],
      stage: {
        root: query.stageDir,
        evidence: join(query.stageDir, '_evidence.json'),
        manifest: join(query.stageDir, '_manifest.json'),
        files: 1,
      },
      stateId: 'state-2',
      ...overrides,
    },
  }
}

function fakeAccess(options = {}) {
  const calls = []
  const session = options.session ?? sessionReport()
  const service = {
    async readTiaSession() {
      calls.push({ operation: 'readTiaSession' })
      return session
    },
    async openProject() {
      throw new Error('project_sync/status must never open a project')
    },
    async saveProjectAs() {
      throw new Error('project_sync/status must never save a project')
    },
    async rebuildSource() {
      throw new Error('project_sync must use syncScan, not rebuildSource')
    },
  }
  if (options.checksum !== undefined) {
    service.readPlcChecksum = async (query) => {
      calls.push({ operation: 'readPlcChecksum', query })
      return typeof options.checksum === 'function' ? options.checksum(query) : options.checksum
    }
  }
  if (options.scan !== undefined) {
    service.syncScan = async (query) => {
      calls.push({ operation: 'syncScan', query })
      return typeof options.scan === 'function' ? options.scan(query) : options.scan
    }
  }
  return { service, calls }
}

function tools(service, config = {}, knowledge = undefined) {
  const services = {}
  if (service !== undefined) services.engineeringAccess = service
  if (knowledge !== undefined) services.knowledgeGraph = knowledge
  const { ctx } = createTestContext({ services })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(config), log: ctx.logger })
  return {
    definitions,
    status: findTool(definitions, STATUS),
    sync: findTool(definitions, SYNC),
  }
}

function fakeKnowledge(options = {}) {
  const calls = []
  return {
    calls,
    service: {
      status: () => ({
        available: true,
        reason: null,
        enginePath: 'engine.exe',
        engineExists: true,
        source: 'config',
        databaseConvention: 'knowledge/<device>/<device>_knowledge.db',
      }),
      async ingestDevice(directory, query) {
        calls.push({ operation: 'ingestDevice', directory, query })
        return {
          ok: options.ingestOk !== false,
          summary: 'ingested',
          data: {
            device: DEVICE,
            dbPath: join(directory, '..', 'knowledge.db'),
            source: 'manifest',
            filesFound: 1,
            filesImported: 1,
            nodes: 10,
            edges: 12,
            byKind: { block: 1 },
            warnings: [],
          },
          error: options.ingestOk === false ? { code: 'INGEST_FAILED', message: 'refused' } : null,
          durationMs: 1,
        }
      },
      async updateDevice(directory, query) {
        calls.push({ operation: 'updateDevice', directory, query })
        if (options.updateCode !== undefined) {
          return { ok: false, summary: 'refused', data: null, error: { code: options.updateCode, message: 'refused' }, durationMs: 1 }
        }
        return {
          ok: true,
          summary: 'updated',
          data: {
            device: DEVICE,
            dbPath: join(directory, '..', 'knowledge.db'),
            changed: query.changedPaths.length,
            removed: (query.removedPaths ?? []).length,
            closure: 0,
            nodes: 5,
            edges: 4,
          },
          error: null,
          durationMs: 1,
        }
      },
    },
  }
}

function evidenceDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: SOFTWARE,
    plcChecksum: 'AA',
    stateId: 'state-1',
    objects: {},
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
}

function objectEntry(overrides = {}) {
  return {
    category: 'block',
    name: 'FB1',
    group: '010',
    path: 'blocks/010/FB1.xml',
    fingerprint: { Code: 'fingerprint-1' },
    ...overrides,
  }
}

async function writeEvidence(deviceDirectory, overrides = {}) {
  await makeFile(join(deviceDirectory, '_evidence.json'), `${JSON.stringify(evidenceDocument(overrides), null, 2)}\n`)
}

async function writeManifest(deviceDirectory, content = '{"files":{}}') {
  await makeFile(join(deviceDirectory, '_manifest.json'), content)
}

function deviceDirectory(root) {
  return join(root, 'source', DEVICE)
}

function operations(calls) {
  return calls.map((call) => call.operation)
}

// ---------------------------------------------------------------------------
// project_status
// ---------------------------------------------------------------------------

test('status without the TIA service fails closed, naming the service', async (t) => {
  const root = await tempWorkspace(t)
  const outcome = assertEnvelope(await executeTool(tools(undefined).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'tia_access_unavailable')
  assert.match(outcome.error.message, /engineeringAccess/u)
})

test('status reports an open project, the missing ledger/manifest and the next action', async (t) => {
  const root = await tempWorkspace(t)
  const { service, calls } = fakeAccess()
  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.device.directory, deviceDirectory(root))
  assert.equal(outcome.data.checksum.state, 'not-checked')
  assert.equal(outcome.data.checksum.value, null)
  assert.equal(outcome.data.evidence.present, false)
  assert.equal(outcome.data.manifest.present, false)
  assert.equal(outcome.data.nextAction, 'sync')
  assert.equal(outcome.data.git.repository, false)
  assert.equal(outcome.data.lock, null)
  assert.equal(outcome.data.wouldSync, null, 'verify=false must not claim the tree is clean')
  assert.equal(outcome.data.syncReason, 'not-checked')
  assert.deepEqual(operations(calls), ['readTiaSession'], 'verify=false must not read the checksum')
  assert.match(outcome.summary, /NOT checked/u)
})

test('status(verify:false) reports wouldSync null and never claims the tree is clean', async (t) => {
  const root = await tempWorkspace(t)
  const device = deviceDirectory(root)
  // Everything a "clean" verdict would need is on disk — but the checksum was
  // not read, so the only honest answer is "cannot tell".
  await writeEvidence(device, { plcChecksum: 'AA' })
  await writeManifest(device)
  const { service, calls } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.checksum.state, 'not-checked')
  assert.equal(outcome.data.wouldSync, null)
  assert.equal(outcome.data.syncReason, 'not-checked')
  assert.match(outcome.details.join('\n'), /Sync: not checked/u)
  assert.deepEqual(operations(calls), ['readTiaSession'])
})

test('status verifies the checksum on request and reports drift, never "clean" by omission', async (t) => {
  const root = await tempWorkspace(t)
  const device = deviceDirectory(root)
  await writeEvidence(device, { plcChecksum: 'AA' })
  await writeManifest(device)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml/>')

  const drifted = fakeAccess({ checksum: checksumReport('CC') })
  const drift = assertEnvelope(await executeTool(tools(drifted.service).status, { verify: true }, fakeExec(root)))
  assert.equal(drift.ok, true)
  assert.equal(drift.data.checksum.state, 'available')
  assert.equal(drift.data.checksum.value, 'CC')
  assert.equal(drift.data.checksum.lastKnown, 'AA')
  assert.equal(drift.data.checksum.drift, true)
  assert.equal(drift.data.wouldSync, true)
  assert.equal(drift.data.syncReason, 'checksum-differs')
  assert.equal(drift.data.nextAction, 'sync')
  assert.match(drift.details.join('\n'), /DIFFERS from the ledger/u)
  assert.match(drift.details.join('\n'), /Sync: needed — checksum differs from the ledger/u)

  const matching = fakeAccess({ checksum: checksumReport('AA') })
  const equal = assertEnvelope(await executeTool(tools(matching.service).status, { verify: true }, fakeExec(root)))
  assert.equal(equal.data.checksum.drift, false)
  assert.equal(equal.data.wouldSync, false)
  assert.equal(equal.data.syncReason, 'in-sync')
  assert.match(equal.details.join('\n'), /Sync: not needed/u)
  assert.equal(equal.data.nextAction, 'git_init', 'no repository yet')

  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Engineering Context Test'])
  const uncommitted = assertEnvelope(await executeTool(tools(matching.service).status, { verify: true }, fakeExec(root)))
  assert.equal(uncommitted.data.git.repository, true)
  assert.ok(uncommitted.data.git.dirty.length > 0)
  assert.equal(uncommitted.data.nextAction, 'commit')

  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  const clean = assertEnvelope(await executeTool(tools(matching.service).status, { verify: true }, fakeExec(root)))
  assert.deepEqual(clean.data.git.dirty, [])
  assert.equal(clean.data.nextAction, 'clean')
})

test('status turns an uncompiled PLC into "compile", not a failure', async (t) => {
  const root = await tempWorkspace(t)
  const { service } = fakeAccess({ checksum: checksumReport(null, { unavailable: true }) })
  const outcome = assertEnvelope(await executeTool(tools(service).status, { verify: true }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.checksum.state, 'unavailable')
  assert.equal(outcome.data.checksum.error.code, 'checksum_unavailable')
  assert.equal(outcome.data.wouldSync, null, 'an unreadable checksum cannot answer "clean"')
  assert.equal(outcome.data.syncReason, 'unavailable')
  assert.equal(outcome.data.nextAction, 'compile')
})

test('status reports a corrupt ledger as data and asks for a sync, not a crash', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(join(deviceDirectory(root), '_evidence.json'), '{ not json')
  const { service } = fakeAccess()
  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.evidence.present, false)
  assert.equal(outcome.data.evidence.invalid, true)
  assert.equal(outcome.data.nextAction, 'sync')
})

test('status surfaces a held lock and never waits on it', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(
    join(root, '.dsh', 'local', 'lock.json'),
    `${JSON.stringify({ pid: 4242, operation: 'sync', startedAt: new Date().toISOString() })}\n`,
  )
  const { service } = fakeAccess()
  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.lock.held, true)
  assert.equal(outcome.data.lock.operation, 'sync')
  assert.equal(outcome.data.lock.pid, 4242)
})

// ---------------------------------------------------------------------------
// project_status: knowledge-graph freshness (the graph plugin's sidecar)
// ---------------------------------------------------------------------------

function graphSidecar(overrides = {}) {
  return {
    schemaVersion: 1,
    device: DEVICE,
    plcChecksum: 'AA',
    stateId: 'state-1',
    builtAt: '2026-10-22T00:00:00.000Z',
    sourceDir: `source/${DEVICE}`,
    ...overrides,
  }
}

async function writeGraphSidecar(root, content = graphSidecar()) {
  await makeFile(join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`), `${JSON.stringify(content, null, 2)}\n`)
}

test('status reports the knowledge graph as fresh when its checksum matches the ledger', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  await writeGraphSidecar(root, graphSidecar({ plcChecksum: 'AA' }))
  const { service } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.present, true)
  assert.equal(outcome.data.knowledge.path, join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`))
  assert.equal(outcome.data.knowledge.schemaVersion, 1)
  assert.equal(outcome.data.knowledge.graphChecksum, 'AA')
  assert.equal(outcome.data.knowledge.sourceChecksum, 'AA')
  assert.equal(outcome.data.knowledge.stateId, 'state-1')
  assert.equal(outcome.data.knowledge.builtAt, '2026-10-22T00:00:00.000Z')
  assert.equal(outcome.data.knowledge.fresh, true)
  assert.match(outcome.details.join('\n'), /Knowledge graph: fresh/u)
  assert.equal(outcome.data.nextAction, 'sync', 'the graph must not change the next action')
})

test('status reports a stale knowledge graph when the checksums differ, without changing the next action', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  await writeGraphSidecar(root, graphSidecar({ plcChecksum: 'BB' }))
  const { service } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.present, true)
  assert.equal(outcome.data.knowledge.graphChecksum, 'BB')
  assert.equal(outcome.data.knowledge.sourceChecksum, 'AA')
  assert.equal(outcome.data.knowledge.fresh, false)
  assert.match(outcome.details.join('\n'), /Knowledge graph: STALE/u)
  assert.equal(outcome.data.nextAction, 'sync', 'a stale graph is reported, never acted on')

  // The verdict is data on a graph that is otherwise absent from the run: no
  // service, no engine, no ingest — the status tool only reads the sidecar.
  assert.equal(outcome.data.knowledge.builtAt, '2026-10-22T00:00:00.000Z')
})

test('a missing graph sidecar is unknown, and status still answers', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  const { service } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.present, false)
  assert.equal(outcome.data.knowledge.fresh, null)
  assert.equal(outcome.data.knowledge.graphChecksum, null)
  assert.equal(outcome.data.knowledge.sourceChecksum, 'AA')
  assert.match(outcome.details.join('\n'), /Knowledge graph: unknown \(no sidecar/u)
  assert.equal(outcome.data.nextAction, 'sync')
})

test('a graph sidecar with no source checksum is unknown, never fresh', async (t) => {
  const root = await tempWorkspace(t)
  await writeGraphSidecar(root, graphSidecar({ plcChecksum: 'AA' }))
  const { service } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.evidence.present, false)
  assert.equal(outcome.data.knowledge.present, true)
  assert.equal(outcome.data.knowledge.graphChecksum, 'AA')
  assert.equal(outcome.data.knowledge.sourceChecksum, null)
  assert.equal(outcome.data.knowledge.fresh, null)
  assert.match(outcome.details.join('\n'), /source checksum is missing/u)
})

test('a corrupt graph sidecar is present but unknown, and never fails the status', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  await makeFile(join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`), '{ not json')
  const { service } = fakeAccess()

  const outcome = assertEnvelope(await executeTool(tools(service).status, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.present, true)
  assert.equal(outcome.data.knowledge.fresh, null)
  assert.match(outcome.details.join('\n'), /Knowledge graph: unknown/u)
})

// ---------------------------------------------------------------------------
// project_sync: the plan (default)
// ---------------------------------------------------------------------------

test('sync is a plan by default: it reads the checksum and writes nothing', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  const { service, calls } = fakeAccess({ checksum: checksumReport('BB') })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.wouldSync, true)
  assert.equal(outcome.data.checksum, 'BB')
  assert.equal(outcome.data.lastKnownChecksum, 'AA')
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum'])
  assert.equal(await exists(join(root, '.dsh', 'local')), false, 'a plan must not even create the state directory')
  assert.equal(await exists(join(root, 'source', DEVICE, '_manifest.json')), false)
})

test('the plan says "already in sync" only when checksum, ledger and manifest all agree', async (t) => {
  const root = await tempWorkspace(t)
  await writeEvidence(deviceDirectory(root), { plcChecksum: 'AA' })
  await writeManifest(deviceDirectory(root))
  const { service, calls } = fakeAccess({ checksum: checksumReport('AA') })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.wouldSync, false)
  assert.match(outcome.summary, /already matches/u)
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum'])

  // A ledger with no manifest is not "in sync": the next sync must rebuild it.
  await rm(join(deviceDirectory(root), '_manifest.json'))
  const noManifest = assertEnvelope(await executeTool(tools(service).sync, {}, fakeExec(root)))
  assert.equal(noManifest.data.wouldSync, true)
  assert.match(noManifest.summary, /no manifest/u)
})

test('the plan turns "no compiled checksum" into needs_compile and scans nothing', async (t) => {
  const root = await tempWorkspace(t)
  const { service, calls } = fakeAccess({ checksum: checksumReport(null, { unavailable: true }) })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, {}, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'needs_compile')
  assert.match(outcome.error.message, /Compile it in TIA Portal/u)
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum'])
})

test('status(verify) warms the cache, so the following plan reads the PLC checksum only once', async (t) => {
  const root = await tempWorkspace(t)
  const device = deviceDirectory(root)
  await writeEvidence(device, { plcChecksum: 'AA' })
  await writeManifest(device)
  const { service, calls } = fakeAccess({ checksum: checksumReport('BB') })
  const { status, sync } = tools(service)

  const verified = assertEnvelope(await executeTool(status, { verify: true }, fakeExec(root)))
  assert.equal(verified.data.checksum.value, 'BB')

  const plan = assertEnvelope(await executeTool(sync, {}, fakeExec(root)))

  assert.equal(plan.ok, true)
  assert.equal(plan.data.checksum, 'BB')
  assert.equal(plan.data.checksumCached, true, 'the plan must say it reused the checksum')
  assert.equal(plan.data.wouldSync, true)
  assert.match(plan.details.join('\n'), /reused from the checksum cache/u)
  assert.equal(
    operations(calls).filter((operation) => operation === 'readPlcChecksum').length,
    1,
    'status + plan must cost exactly one PLC checksum read',
  )
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum', 'readTiaSession'])
})

// ---------------------------------------------------------------------------
// project_sync: the real run
// ---------------------------------------------------------------------------

test('a real sync copies only the promoted XML, writes both documents and leaves the commit pending', async (t) => {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await writeEvidence(device, { plcChecksum: 'AA' })
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>old</xml>')
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const { service, calls } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(
          evidenceDocument({
            plcChecksum: 'BB',
            stateId: 'state-2',
            objects: { 'block||FB1': objectEntry({ fingerprint: { Code: 'fingerprint-2' } }) },
          }),
          null,
          2,
        )}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"files":{"blocks/010/FB1.xml":{}}}')
      return scanReport(query)
    },
  })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.unchanged, false)
  assert.equal(outcome.data.manifestRebuilt, true)
  assert.equal(outcome.data.counts.changed, 1)
  assert.equal(outcome.data.copied, 1)
  assert.equal(await readFile(join(device, 'blocks', '010', 'FB1.xml'), 'utf8'), '<xml>FB1</xml>')
  assert.equal(
    JSON.parse(await readFile(join(device, '_evidence.json'), 'utf8')).plcChecksum,
    'BB',
    'the ledger is written beside the XML',
  )
  assert.match(await readFile(join(device, '_manifest.json'), 'utf8'), /FB1\.xml/u)

  // The sync writes the tree and stops. It reports what is left for the commit,
  // and the suggested message carries the facts the commit will record.
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head, 'a sync must not create a commit')
  assert.equal(outcome.data.pending.paths.length, 3, 'the XML and both ledger documents are left dirty')
  assert.ok(
    outcome.data.pending.paths.includes('source/PLC1/blocks/010/FB1.xml'),
    'the promoted block is listed for the commit',
  )
  assert.match(outcome.data.pending.suggestedMessage, /^sync: PLC1 — 1 changed, 0 added, 0 removed, manifest rebuilt$/mu)
  assert.match(outcome.data.pending.suggestedMessage, /^Tia-Op: sync$/mu)
  assert.match(outcome.data.pending.suggestedMessage, /^Tia-Checksum: BB$/mu)
  assert.match(outcome.data.pending.suggestedMessage, /^Tia-State: state-2$/mu)
  assert.match(outcome.data.pending.suggestedMessage, /^Tia-Manifest: rebuilt$/mu)

  const dirty = (await git(root, ['status', '--porcelain', '--', 'source/PLC1'])).stdout.trim()
  assert.match(dirty, /M source\/PLC1\/blocks\/010\/FB1\.xml/u, 'the change is left dirty for project_commit')
  assert.equal((await readdir(join(root, '.dsh', 'local', 'stage'))).length, 0, 'STAGE is scratch space and must be cleaned')
  assert.equal(await exists(join(root, '.dsh', 'local', 'lock.json')), false, 'the lock is released')
  assert.deepEqual(operations(calls), ['readTiaSession', 'syncScan'])
  assert.equal(calls[1].query.sourceRoot, device, 'the scan resolves manifest paths against the device directory')
  assert.equal(calls[1].query.evidencePath, join(device, '_evidence.json'))
  assert.equal(calls[1].query.manifestPath, join(device, '_manifest.json'))
})

test('an unchanged scan is a no-op: no copy, nothing pending, STAGE removed', async (t) => {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await writeEvidence(device, { plcChecksum: 'AA' })
  await writeManifest(device)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>old</xml>')
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const { service, calls } = fakeAccess({
    scan: { ok: true, summary: 'unchanged', data: { checksum: 'AA', unchanged: true, manifestRebuilt: false, stateId: 'state-1' } },
  })
  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.unchanged, true)
  assert.equal(outcome.data.copied, 0)
  assert.equal(outcome.data.removedFiles, 0)
  assert.deepEqual(outcome.data.pending, { paths: [], suggestedMessage: '' }, 'nothing may be left for the commit')
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head, 'an unchanged scan must not create a commit')
  assert.equal(await readFile(join(device, 'blocks', '010', 'FB1.xml'), 'utf8'), '<xml>old</xml>')
  assert.deepEqual(operations(calls), ['readTiaSession', 'syncScan'])
  assert.equal((await readdir(join(root, '.dsh', 'local', 'stage'))).length, 0)
})

test('a disappeared object deletes its file; an unexportable one keeps its previous file', async (t) => {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await writeEvidence(device, {
    plcChecksum: 'AA',
    objects: {
      'block||FB1': objectEntry(),
      'block||FB2': objectEntry({ name: 'FB2', path: 'blocks/010/FB2.xml' }),
      'block||FB3': objectEntry({ name: 'FB3', path: 'blocks/010/FB3.xml' }),
    },
  })
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>old 1</xml>')
  await makeFile(join(device, 'blocks', '010', 'FB2.xml'), '<xml>old 2</xml>')
  await makeFile(join(device, 'blocks', '010', 'FB3.xml'), '<xml>old 3</xml>')
  await writeManifest(device)
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])

  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>new 1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(
          evidenceDocument({
            plcChecksum: 'BB',
            stateId: 'state-2',
            objects: {
              'block||FB1': objectEntry({ fingerprint: { Code: 'fingerprint-2' } }),
              'block||FB3': objectEntry({ name: 'FB3', path: 'blocks/010/FB3.xml', state: 'unexportable', reason: 'TIA refused' }),
            },
          }),
          null,
          2,
        )}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"files":{}}')
      return scanReport(query, {
        counts: { blocks: 3, types: 0, tagTables: 0, changed: 1, added: 0, removed: 1, unexportable: 1 },
        removed: [{ key: 'block||FB2', category: 'block', name: 'FB2', group: '010', faces: [] }],
        unexportable: [{ key: 'block||FB3', category: 'block', name: 'FB3', group: '010', reason: 'TIA refused' }],
      })
    },
  })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.removedFiles, 1)
  assert.equal(await readFile(join(device, 'blocks', '010', 'FB1.xml'), 'utf8'), '<xml>new 1</xml>')
  assert.equal(await exists(join(device, 'blocks', '010', 'FB2.xml')), false, 'a vanished object leaves no stale file')
  assert.equal(
    await readFile(join(device, 'blocks', '010', 'FB3.xml'), 'utf8'),
    '<xml>old 3</xml>',
    'an unexportable object still exists in TIA, so its last good export is kept',
  )
})

test('a corrupt ledger is rebuilt by the next sync instead of blocking it', async (t) => {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await makeFile(join(device, '_evidence.json'), '{ not json')
  await writeManifest(device)

  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(evidenceDocument({ objects: { 'block||FB1': objectEntry() } }), null, 2)}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"files":{}}')
      return scanReport(query)
    },
  })
  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.removedFiles, 0, 'without a readable previous ledger, nothing is deleted')
  assert.equal(JSON.parse(await readFile(join(device, '_evidence.json'), 'utf8')).schemaVersion, 1)
})

test('a recorded device directory from a moved workspace is a hint, not authority', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: 'PEI_SinoARP', directory: 'tia/x', sourceRoot: 'source' },
      devices: [{ device: DEVICE, software: SOFTWARE, directory: join(root, 'tia', DEVICE) }],
    }),
  )
  const { service } = fakeAccess({ checksum: checksumReport('AA') })
  const outcome = assertEnvelope(await executeTool(tools(service).sync, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.device.directory, join(root, 'source', DEVICE))
})

test('a workspace that is not a repository is refused before anything is scanned', async (t) => {
  const root = await tempWorkspace(t)
  const { service, calls } = fakeAccess({ scan: () => scanReport({ stageDir: join(root, 'unused') }) })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'repository_not_found')
  assert.match(outcome.error.message, /never creates one/u)
  assert.deepEqual(operations(calls), ['readTiaSession'], 'no scan is attempted without a repository')
  assert.equal(await exists(join(root, 'source', DEVICE)), false)
})

test('a held lock stops a real sync before the scan', async (t) => {
  const root = await gitWorkspace(t)
  await makeFile(
    join(root, '.dsh', 'local', 'lock.json'),
    `${JSON.stringify({ pid: process.pid, operation: 'sync', startedAt: new Date().toISOString() })}\n`,
  )
  const { service, calls } = fakeAccess({ scan: () => scanReport({ stageDir: join(root, 'unused') }) })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'lock_held')
  assert.match(outcome.error.message, /held by another operation/u)
  assert.deepEqual(operations(calls), ['readTiaSession'])
})

test('a scan that finds no compiled checksum leaves no STAGE and no source change', async (t) => {
  const root = await gitWorkspace(t)
  const { service } = fakeAccess({
    scan: {
      ok: false,
      summary: 'cannot scan',
      error: { code: 'checksum_unavailable', message: 'compile the PLC first' },
    },
  })

  const outcome = assertEnvelope(await executeTool(tools(service).sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'needs_compile')
  assert.equal(await exists(join(root, 'source', DEVICE)), false)
  assert.equal((await readdir(join(root, '.dsh', 'local', 'stage'))).length, 0, 'a failed scan must not leave scratch files')
})

// ---------------------------------------------------------------------------
// the checksum cache: warm by read-only calls only, never by a real sync
// ---------------------------------------------------------------------------

test('a real sync always scans and refreshes the cache with the scan checksum', async (t) => {
  const root = await gitWorkspace(t)
  const { service, calls } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(
          evidenceDocument({
            plcChecksum: 'BB',
            stateId: 'state-2',
            objects: { 'block||FB1': objectEntry({ fingerprint: { Code: 'fingerprint-2' } }) },
          }),
          null,
          2,
        )}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"files":{"blocks/010/FB1.xml":{}}}')
      return scanReport(query)
    },
  })
  const { sync } = tools(service)

  const outcome = assertEnvelope(await executeTool(sync, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.checksum, 'BB')
  assert.deepEqual(operations(calls), ['readTiaSession', 'syncScan'], 'a real sync never reads the checksum separately')

  const cached = readCachedChecksum(checksumCacheKey(root, DEVICE, SOFTWARE))
  assert.ok(cached, 'the real sync must leave a fresh cache entry')
  assert.equal(cached.checksum, 'BB')

  // And the plan after it reuses that entry instead of asking TIA again. The
  // fake service deliberately has no readPlcChecksum, so a miss would fail.
  const plan = assertEnvelope(await executeTool(sync, {}, fakeExec(root)))
  assert.equal(plan.ok, true)
  assert.equal(plan.data.checksumCached, true)
  assert.equal(plan.data.checksum, 'BB')
  assert.equal(plan.data.wouldSync, false, 'ledger and manifest both match BB after the real sync')
  assert.deepEqual(operations(calls), ['readTiaSession', 'syncScan', 'readTiaSession'])
})

test('the checksum cache expires after CHECKSUM_TTL_MS (no sleeping)', () => {
  clearChecksumCache()
  const key = checksumCacheKey('C:\\workspace', DEVICE, SOFTWARE)

  assert.equal(readCachedChecksum(key), null, 'an empty cache is a miss')

  writeCachedChecksum(key, 'AA')
  const hit = readCachedChecksum(key)
  assert.ok(hit)
  assert.equal(hit.checksum, 'AA')
  assert.equal(hit.cached, true)
  assert.ok(hit.ageMs >= 0 && hit.ageMs <= CHECKSUM_TTL_MS)

  assert.equal(readCachedChecksum(key, hit.storedAt + CHECKSUM_TTL_MS)?.checksum, 'AA', 'fresh at the TTL boundary')
  assert.equal(readCachedChecksum(key, hit.storedAt + CHECKSUM_TTL_MS + 1), null, 'expired one millisecond past the TTL')
  assert.equal(readCachedChecksum(key), null, 'an expired entry is dropped, not merely hidden')

  // The key includes the workspace, device and software, so an entry never
  // crosses those boundaries.
  writeCachedChecksum(key, 'BB')
  assert.equal(readCachedChecksum(checksumCacheKey('C:\\other-workspace', DEVICE, SOFTWARE)), null)
  assert.equal(readCachedChecksum(checksumCacheKey('C:\\workspace', 'PLC2', SOFTWARE)), null)
  assert.equal(readCachedChecksum(checksumCacheKey('C:\\workspace', DEVICE, 'SW2')), null)

  clearChecksumCache()
  assert.equal(readCachedChecksum(key), null, 'clearChecksumCache drops everything')
})


// ---------------------------------------------------------------------------
// project_sync: optional knowledge-graph refresh
// ---------------------------------------------------------------------------

function stageFiles(query, objects, category = 'block') {
  const paths = Object.values(objects).map((entry) => entry.path).filter((path) => typeof path === 'string')
  for (const path of paths) {
    const content = category === 'type' ? '<xml>type</xml>' : '<xml>block</xml>'
    return { path, content }
  }
  return null
}

test('refresh_knowledge updates the graph incrementally for a block-only change', async (t) => {
  const root = await gitWorkspace(t)
  const knowledge = fakeKnowledge()
  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(evidenceDocument({ objects: { 'block||FB1': objectEntry() } }), null, 2)}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"blocks":[]}')
      return scanReport(query)
    },
  })

  const outcome = assertEnvelope(
    await executeTool(tools(service, {}, knowledge.service).sync, { dry_run: false, refresh_knowledge: true }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(knowledge.calls.map((call) => call.operation), ['updateDevice'])
  assert.deepEqual(knowledge.calls[0].query.changedPaths, ['blocks/010/FB1.xml'])
  assert.equal(outcome.data.knowledge.state, 'updated')
  assert.equal(outcome.data.knowledge.mode, 'incremental')
})

test('a type change forces a full graph rebuild instead of an incremental update', async (t) => {
  const root = await gitWorkspace(t)
  const knowledge = fakeKnowledge()
  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'types', 'UDT1.xml'), '<xml>type</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(
          evidenceDocument({
            objects: { 'type||UDT1': objectEntry({ category: 'type', name: 'UDT1', path: 'types/UDT1.xml' }) },
          }),
          null,
          2,
        )}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"blocks":[]}')
      return scanReport(query, {
        changed: [{ key: 'type||UDT1', category: 'type', name: 'UDT1', group: null, faces: ['Interface'] }],
      })
    },
  })

  const outcome = assertEnvelope(
    await executeTool(tools(service, {}, knowledge.service).sync, { dry_run: false, refresh_knowledge: true }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(knowledge.calls.map((call) => call.operation), ['ingestDevice'])
  assert.equal(outcome.data.knowledge.mode, 'full')
  assert.equal(outcome.data.knowledge.forcedFull, true)
  assert.equal(outcome.data.knowledge.state, 'rebuilt')
})

test('an incremental refusal falls back to a full rebuild', async (t) => {
  const root = await gitWorkspace(t)
  const knowledge = fakeKnowledge({ updateCode: 'UPDATE_TOO_LARGE' })
  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(evidenceDocument({ objects: { 'block||FB1': objectEntry() } }), null, 2)}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"blocks":[]}')
      return scanReport(query)
    },
  })

  const outcome = assertEnvelope(
    await executeTool(tools(service, {}, knowledge.service).sync, { dry_run: false, refresh_knowledge: true }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(knowledge.calls.map((call) => call.operation), ['updateDevice', 'ingestDevice'])
  assert.equal(outcome.data.knowledge.mode, 'full')
  assert.equal(outcome.data.knowledge.state, 'rebuilt')
})

test('refresh_knowledge is off by default and a graph failure is only a warning', async (t) => {
  const root = await gitWorkspace(t)
  const knowledge = fakeKnowledge({ updateCode: 'UPDATE_FAILED' })
  const { service } = fakeAccess({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(
        join(query.stageDir, '_evidence.json'),
        `${JSON.stringify(evidenceDocument({ objects: { 'block||FB1': objectEntry() } }), null, 2)}\n`,
      )
      await makeFile(join(query.stageDir, '_manifest.json'), '{"blocks":[]}')
      return scanReport(query)
    },
  })

  const off = assertEnvelope(await executeTool(tools(service, {}, knowledge.service).sync, { dry_run: false }, fakeExec(root)))
  assert.equal(off.ok, true)
  assert.equal(off.data.knowledge, null)
  assert.deepEqual(knowledge.calls, [])

  const failed = assertEnvelope(
    await executeTool(tools(service, {}, knowledge.service).sync, { dry_run: false, refresh_knowledge: true }, fakeExec(root)),
  )
  assert.equal(failed.ok, true)
  assert.equal(failed.data.knowledge.state, 'failed')
  assert.ok(failed.warnings.some((warning) => /knowledge graph was not refreshed/u.test(warning)))
})

test('the plan announces refresh_knowledge without calling the graph service', async (t) => {
  const root = await tempWorkspace(t)
  const knowledge = fakeKnowledge()
  const { service } = fakeAccess({ checksum: checksumReport('AA') })
  const outcome = assertEnvelope(
    await executeTool(tools(service, {}, knowledge.service).sync, { refresh_knowledge: true }, fakeExec(root)),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.wouldRefreshKnowledge, true)
  assert.deepEqual(knowledge.calls, [])
})
