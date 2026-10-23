/**
 * `create_engineering_project`, driven directly with a stand-in context.
 *
 * What is asserted is the contract the model and the workspace depend on: the
 * plan is the default and writes nothing, a real run saves before it exports,
 * TIA's own path is what the result carries, a stopped controller is a state
 * rather than a spawn, every TIA refusal is reported, and the only file this
 * plugin authors on its own (the workspace `.gitignore`) is never rewritten.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  fakeExecWithoutCwd,
  fakeGitContext,
  findTool,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  renderedText,
  tempWorkspace,
} from './helpers/harness.mjs'

const { resolveConfig } = await loadConfigModule()
const { TOOL_NAMES, toolDefinitions } = await loadToolsModule()

const TOOL = 'create_engineering_project'

/** What the TIA service reports about the session, by default: a project is open elsewhere. */
function sessionReport(overrides = {}) {
  return {
    running: true,
    projectOpen: true,
    projectName: 'PEI_SinoARP',
    projectPath: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17',
    isModified: false,
    software: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }],
    reason: null,
    ...overrides,
  }
}

/** What the TIA service reports after a rebuild, in the layout it owns. */
function rebuildReport(sourceRoot, overrides = {}) {
  const device = (name, software, counts) => ({
    device: name,
    software,
    directory: join(sourceRoot, name),
    blockCount: counts.blocks + counts.types + counts.tagTables,
    skipped: counts.skipped ?? 0,
    verificationFailed: 0,
    blocks: {
      exported: counts.blocks,
      failed: 0,
      directory: join(sourceRoot, name, 'blocks'),
      manifest: join(sourceRoot, name, 'blocks', '_manifest.json'),
    },
    types: {
      exported: counts.types,
      failed: 0,
      directory: join(sourceRoot, name, 'types'),
      manifest: join(sourceRoot, name, '_manifest.json'),
    },
    tagTables: {
      exported: counts.tagTables,
      failed: 0,
      directory: join(sourceRoot, name, 'tag_tables'),
      manifest: null,
    },
  })
  const report = {
    ok: true,
    error: null,
    summary: 'Rebuilt the source tree.',
    sourceRoot,
    devices: [device('S7-1500', 'PLC_1', { blocks: 2, types: 1, tagTables: 1 })],
    failures: [],
    missingDevices: [],
    ...overrides,
  }
  // The service's *own* success payload: `data.failures` is the very same array as
  // the top-level `failures`. A live session reported one refused object as two
  // because the normalizer counted both; mirroring that shape here is the guard.
  if (report.data === undefined) {
    report.data = {
      sourceRoot,
      devices: report.devices,
      failures: report.failures,
      missingDevices: report.missingDevices,
    }
  }
  return report
}

/** A stand-in `engineeringAccess` service that records every call in order. */
function fakeAccess(options = {}) {
  const calls = []
  const service = {
    async readTiaSession(request = {}) {
      calls.push({ operation: 'readTiaSession', options: request })
      if (options.readThrows !== undefined) throw options.readThrows
      return options.session ?? sessionReport()
    },
    async openProject(projectPath, request = {}) {
      calls.push({ operation: 'openProject', projectPath, options: request })
      if (options.openThrows !== undefined) throw options.openThrows
      if (options.open !== undefined) return options.open
      return {
        ok: true,
        error: null,
        summary: 'Opened the project.',
        data: {
          projectName: 'PEI_SinoARP',
          projectPath,
          requestedPath: projectPath,
          upgraded: false,
          isModified: false,
          plcSoftware: { count: 1, items: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }] },
        },
      }
    },
    async saveProjectAs(directory, request = {}) {
      calls.push({ operation: 'saveProjectAs', directory, options: request })
      if (options.saveThrows !== undefined) throw options.saveThrows
      if (options.save !== undefined) return options.save
      // A real save-as leaves the project on disk where TIA put it.
      await mkdir(directory, { recursive: true })
      return {
        ok: true,
        error: null,
        summary: 'Saved the project.',
        data: {
          requestedSaveAsDir: directory,
          savedAs: join(directory, 'PEI_SinoARP.ap17'),
          projectPath: directory,
          // TIA names the project after the directory it saved into.
          projectName: basename(directory),
        },
      }
    },
    async rebuildSource(sourceRoot, request = {}) {
      calls.push({ operation: 'rebuildSource', sourceRoot, options: request })
      if (options.rebuildThrows !== undefined) throw options.rebuildThrows
      if (options.rebuild !== undefined) return options.rebuild
      // A real rebuild writes the source tree under the root it was given.
      await mkdir(join(sourceRoot, 'S7-1500', 'blocks'), { recursive: true })
      return rebuildReport(sourceRoot)
    },
    async readPlcChecksum(query = {}) {
      calls.push({ operation: 'readPlcChecksum', query })
      if (options.checksumThrows !== undefined) throw options.checksumThrows
      if (options.checksum !== undefined) {
        return typeof options.checksum === 'function' ? options.checksum(query) : options.checksum
      }
      return { ok: true, summary: 'checksum read', data: { checksum: 'CHECKSUM-1', device: query.deviceName, software: query.softwareName } }
    },
    async syncScan(query) {
      calls.push({ operation: 'syncScan', query })
      if (options.scanThrows !== undefined) throw options.scanThrows
      if (options.scan !== undefined) {
        return typeof options.scan === 'function' ? options.scan(query) : options.scan
      }
      // The bootstrap shape: the controller adopts the exported files and writes
      // the ledger and the manifest into STAGE. No XML is exported again.
      const evidence = join(query.stageDir, '_evidence.json')
      const manifest = join(query.stageDir, '_manifest.json')
      await makeFile(
        evidence,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            hashAlgo: 'sha256',
            device: query.deviceName ?? null,
            software: query.softwareName ?? null,
            plcChecksum: 'CHECKSUM-1',
            stateId: 'state-create',
            objects: {},
            unexportable: [],
            tombstones: [],
          },
          null,
          2,
        )}\n`,
      )
      await makeFile(manifest, '{"files":{}}\n')
      return {
        ok: true,
        summary: 'scan complete',
        data: {
          checksum: 'CHECKSUM-1',
          unchanged: false,
          manifestRebuilt: true,
          counts: { blocks: 2, types: 1, tagTables: 1, changed: 0, added: 0, removed: 0, unexportable: 0 },
          changed: [],
          added: [],
          removed: [],
          unexportable: [],
          stage: { root: query.stageDir, evidence, manifest, files: 0 },
          stateId: 'state-create',
          adopted: 4,
        },
      }
    },
  }
  return { service, calls }
}

/** A stand-in `knowledgeGraph` service that records every call in order. */
function fakeKnowledgeGraph(options = {}) {
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
      const reply = options.ingest?.(deviceDir, request)
      if (reply !== undefined) return reply
      const device = basename(deviceDir)
      const dbPath = join(sourceRootOf(deviceDir), 'knowledge', device, `${device}_knowledge.db`)
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

/** `<root>/source/<device>` → `<root>`, matching the graph plugin's own convention. */
function sourceRootOf(deviceDir) {
  return dirname(dirname(deviceDir))
}

function toolWith(config = {}, services = {}) {
  const { ctx } = createTestContext({ services })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(config), log: ctx.logger })
  return findTool(definitions, TOOL)
}

/** The tool in front of a fake service, plus its call log. */
function setup(options = {}, config = {}) {
  const { service, calls } = fakeAccess(options)
  const git = options.gitContext ?? fakeGitContext()
  const services = { engineeringAccess: service, gitContext: git.service }
  if (options.knowledgeGraph !== undefined) services.knowledgeGraph = options.knowledgeGraph.service
  return { tool: toolWith(config, services), calls, graph: options.knowledgeGraph ?? null, git: git.calls, gitState: git.state }
}

const operations = (calls) => calls.map((call) => call.operation)

test('this build registers the four workflow tools in a stable order', () => {
  assert.deepEqual([...TOOL_NAMES], [TOOL, 'project_status', 'project_sync', 'project_commit'])
})

test('a composition without the TIA service says so instead of half-creating a project', async (t) => {
  const root = await tempWorkspace(t)
  const outcome = assertEnvelope(await executeTool(toolWith(), {}, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'tia_access_unavailable')
  assert.match(outcome.error.message, /engineeringAccess/u)
  await assert.rejects(stat(join(root, 'tia', basename(root))), 'nothing may be created without a way to reach TIA')
})

test('with nothing open it asks for the project path instead of hunting for one', async (t) => {
  const root = await tempWorkspace(t)

  // Controller running, no project open.
  const nothingOpen = setup({
    session: sessionReport({
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is running but no project is open',
    }),
  })
  const asked = await executeTool(nothingOpen.tool, { dry_run: false }, fakeExec(root))
  assert.equal(asked.ok, false)
  assert.equal(asked.error.code, 'source_project_required')
  assert.match(asked.error.message, /ask the user for the path/u)
  assert.match(asked.error.message, /rather than\s+searching the disk/u)
  assert.deepEqual(operations(nothingOpen.calls), ['readTiaSession'], 'nothing may be opened or saved without a path')

  // Controller not running either: same actionable answer, because opening starts it.
  const stopped = setup({
    session: sessionReport({
      running: false,
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is not running, so no TIA session is open',
    }),
  })
  const alsoAsked = await executeTool(stopped.tool, { dry_run: false }, fakeExec(root))
  assert.equal(alsoAsked.ok, false)
  assert.equal(alsoAsked.error.code, 'source_project_required')
  assert.deepEqual(operations(stopped.calls), ['readTiaSession'])

  await assert.rejects(stat(join(root, 'tia', basename(root))), 'nothing may be created without a project')
})

test('a named project is opened, then saved and exported', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Line1.ap17')
  await makeFile(source, 'project bytes')
  const { tool, calls } = setup({
    session: sessionReport({
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is running but no project is open',
    }),
  })

  const outcome = assertEnvelope(
    await executeTool(tool, { source_project: source, dry_run: false }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(operations(calls), [
    'readTiaSession',
    'openProject',
    'readPlcChecksum',
    'saveProjectAs',
    'rebuildSource',
    'syncScan',
  ])
  assert.equal(calls[1].projectPath, source)
  assert.equal(calls[1].options.withWindow, true, 'a visible TIA window is the default')
  assert.equal(calls[1].options.allowUpgrade, false, 'upgrading rewrites the project, so it is never implied')
  assert.equal(calls[3].directory, join(root, 'tia', basename(root)))
  assert.equal(calls[4].sourceRoot, join(root, 'source'))
  assert.equal(outcome.data.project.name, 'PEI_SinoARP')
})

test('a different project is never acted on silently', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup() // session: PEI_SinoARP is open elsewhere

  const outcome = await executeTool(
    tool,
    { source_project: join(root, 'Other.ap17'), dry_run: false },
    fakeExec(root),
  )

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'project_already_open')
  assert.deepEqual(operations(calls), ['readTiaSession'], 'TIA refuses a second open anyway; do not try')
  assert.equal(outcome.error.details.requested, join(root, 'Other.ap17'))

  // The same project passed explicitly is fine: it is what is already open.
  const same = await executeTool(
    setup().tool,
    { source_project: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17', dry_run: false },
    fakeExec(root),
  )
  assert.equal(same.ok, true)
})

test('a refused open reports TIA\'s reason and warns about the upgrade switch', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Old.ap15')
  await makeFile(source, 'project bytes')
  const { tool } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: false,
      error: { code: 'project_open_failed', message: 'this project was created by an older version' },
      summary: '',
      data: null,
    },
  })

  const outcome = await executeTool(tool, { source_project: source, dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'open_failed')
  assert.match(outcome.error.message, /older version/u)
  assert.match(outcome.error.message, /allow_upgrade/u)
  assert.match(outcome.error.message, /REWRITES/u)
  assert.equal(outcome.error.details.code, 'project_open_failed')
})

test('an upgrade that TIA did perform is reported loudly', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Old.ap15')
  await makeFile(source, 'project bytes')
  const { tool } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: true,
      error: null,
      summary: 'Opened.',
      data: {
        projectName: 'PEI_SinoARP',
        projectPath: source,
        requestedPath: source,
        upgraded: true,
        isModified: false,
        plcSoftware: { count: 1, items: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }] },
      },
    },
  })

  const outcome = await executeTool(
    tool,
    { source_project: source, allow_upgrade: true, dry_run: false },
    fakeExec(root),
  )

  assert.equal(outcome.ok, true)
  assert.ok(
    outcome.warnings.some((warning) => /upgraded .* to V17/u.test(warning)),
    'an irreversible rewrite has to be visible in the result',
  )
})

test('the default is a plan: it names the layout and writes nothing at all', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  const outcome = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.deepEqual(operations(calls), ['readTiaSession'], 'a plan asks nothing of TIA beyond the session')
  assert.equal(outcome.data.plan.name, 'PEI_SinoARP')
  assert.equal(outcome.data.plan.projectDirectory.port, `tia/${basename(root)}`)
  assert.equal(outcome.data.plan.sourceRoot.port, 'source')
  assert.equal(outcome.data.plan.skipSave, false)
  assert.deepEqual(outcome.data.plan.devices, [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }])

  await assert.rejects(stat(join(root, 'tia', basename(root))), 'a dry run must not create the project directory')
  await assert.rejects(stat(join(root, 'source')), 'a dry run must not create the source tree')
  await assert.rejects(stat(join(root, '.gitignore')), 'a dry run must not touch the workspace .gitignore')
  await assert.rejects(stat(join(root, '.gitattributes')), 'a dry run must not touch .gitattributes')
  await assert.rejects(stat(join(root, '.dsh', 'local', 'repo.json')), 'a dry run must not write the ownership marker')
  assert.equal(outcome.data.plan.git.initialize, true, 'the plan has to say the repository will be created')
  assert.equal(outcome.data.plan.git.baselineCommit, true)
  assert.match(outcome.details.join('\n'), /git init -b main/u)
  assert.match(renderedText(tool, {}, outcome), /Dry run/u)
})

test('dry_run=false saves into tia/ and then rebuilds into source/, in that order', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, false)
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum', 'saveProjectAs', 'rebuildSource', 'syncScan'])
  assert.equal(calls[2].directory, join(root, 'tia', basename(root)))
  assert.equal(calls[3].sourceRoot, join(root, 'source'))
  assert.equal(calls[3].options.overwrite, false)

  // TIA's own path is what the result carries, never the requested directory.
  assert.equal(outcome.data.project.savedAs, join(root, 'tia', basename(root), 'PEI_SinoARP.ap17'))
  // The payload describes the disk after the run, not what the plan found before it.
  assert.equal(outcome.data.project.directory.kind, 'directory')
  assert.equal(outcome.data.project.sourceRoot.kind, 'directory')
  // Planned and written are different numbers, and the plan's counts are the ones
  // that include skipped files: all four planned objects were really written here.
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 4, skipped: 0, refused: 0, verificationFailed: 0 })
  assert.equal(outcome.data.rebuild.nothingWritten, false)
  assert.ok(
    outcome.warnings.some((warning) => /TIA named the workspace copy/u.test(warning)),
    'the rename TIA performs is reported',
  )
  assert.equal(outcome.data.ignore.action, 'created')
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^tia\/$/mu)
  assert.match(outcome.summary, /Saved PEI_SinoARP into tia\//u)

  // The index is the workspace-level entry point: it says which project the tree
  // belongs to (the controller writes one manifest per device, not per project).
  assert.equal(outcome.data.index.action, 'created')
  const index = JSON.parse(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'))
  assert.equal(index.project.name, 'PEI_SinoARP')
  assert.equal(index.project.directory, `tia/${basename(root)}`)
  assert.equal(index.project.sourceRoot, 'source')
  assert.equal(index.devices.length, 1)
  assert.equal(index.devices[0].device, 'S7-1500')
  assert.match(index.devices[0].manifest, /_manifest\.json$/u)
  assert.deepEqual(index.totals, { planned: 4, written: 4, skipped: 0, refused: 0, verificationFailed: 0 })
})

test('overwrite is passed through to the export', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  await executeTool(tool, { dry_run: false, overwrite: true }, fakeExec(root))

  assert.equal(calls[3].options.overwrite, true)
})

test('a refused save stops there: the source tree is not touched and no ignore rule is written', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup({
    save: {
      ok: false,
      error: { code: 'project_exists', message: 'a project named PEI_SinoARP already exists in that directory' },
      summary: '',
      data: null,
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'save_failed')
  assert.match(outcome.error.message, /already exists/u)
  assert.equal(outcome.error.details.code, 'project_exists')
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum', 'saveProjectAs'])
  await assert.rejects(stat(join(root, '.gitignore')), 'the ignore rule belongs to a project that is really there')
})

test('a failed rebuild says the project is saved, so a retry only redoes the export', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: {
      ok: false,
      error: { code: 'controller_timeout', message: 'the controller did not answer in time' },
      summary: '',
      sourceRoot: join(root, 'source'),
      devices: [],
      failures: [{ device: 'S7-1500', category: 'blocks', name: 'OB1', code: 'export_failed', message: 'boom' }],
      missingDevices: [],
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'rebuild_failed')
  assert.match(outcome.error.message, /only redoes the export/u)
  assert.equal(outcome.error.details.code, 'controller_timeout')
  assert.equal(outcome.error.details.failures.length, 1)
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^tia\/$/mu, 'the saved half keeps its ignore rule')
})

test('objects TIA refuses are reported per object and do not fail the call', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: rebuildReport(join(root, 'source'), {
      summary: 'Rebuilt 1 device; 1 object refused.',
      failures: [
        { device: 'S7-1500', category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' },
      ],
    }),
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.rebuild.failures.length, 1)
  // One of the four planned objects was refused, so three reached the disk.
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 3, skipped: 0, refused: 1, verificationFailed: 0 })
  assert.ok(
    outcome.warnings.some((warning) => /refused/u.test(warning)),
    'a refusal is material and must be a warning',
  )
  assert.match(renderedText(tool, {}, outcome), /Refused: S7-1500\/blocks\/FOB_SAFETY/u)
})

test('a run where every file already exists is reported as such, not as a TIA refusal', async (t) => {
  const root = await tempWorkspace(t)
  // The project is already in the workspace, so this is the plain "refresh the
  // tree" path — the run that used to come back as a hard failure.
  const inside = join(root, 'tia', basename(root), 'PEI_SinoARP.ap17')
  await makeFile(inside, 'project bytes')
  const sourceRoot = join(root, 'source')

  const { tool } = setup({
    session: sessionReport({ projectPath: inside }),
    rebuild: {
      ok: false,
      error: { code: 'export_failed', message: 'No object could be exported: Openness refused all 4 object(s).' },
      summary: '',
      sourceRoot,
      devices: [],
      failures: [],
      missingDevices: [],
      // The controller's partial payload: nothing written, four files skipped,
      // nothing refused — yet it reports `export_failed`.
      data: {
        counts: { blocks: 0, types: 3, tagTables: 1 },
        summary: { exported: 0, skipped: 4, failed: 0, verificationFailed: 0 },
      },
    },
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true, 'nothing was refused: the files were simply already there')
  assert.equal(outcome.error, null)
  assert.equal(outcome.dryRun, false)
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 0, skipped: 4, refused: 0, verificationFailed: 0 })
  assert.equal(outcome.data.rebuild.nothingWritten, true)
  // The controller's misleading "refused all" wording must not reach the model.
  assert.doesNotMatch(outcome.summary, /refus/iu)
  assert.match(outcome.summary, /already present/u)
  assert.match(outcome.summary, /overwrite=true/u)
  assert.ok(
    outcome.warnings.some((warning) => /may be stale/u.test(warning)),
    'the caller has to be told the tree was left exactly as it was',
  )
  assert.ok(
    outcome.warnings.some((warning) => /not examined at all/u.test(warning)),
    'the plugin stops at the first device it cannot finish, so the ones after it are named',
  )
})

test('a run that refused objects stays a failure even when it also skipped some', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: {
      ok: false,
      error: { code: 'export_failed', message: 'One object was refused.' },
      summary: '',
      sourceRoot: join(root, 'source'),
      devices: [],
      failures: [],
      missingDevices: [],
      data: {
        counts: { blocks: 2, types: 1, tagTables: 0 },
        summary: { exported: 1, skipped: 1, failed: 1, verificationFailed: 0 },
        failures: [{ category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' }],
      },
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'rebuild_failed')
  assert.match(outcome.error.message, /only redoes the export/u)
  // How far it got is part of the failure, not left to be guessed.
  assert.deepEqual(outcome.error.details.totals, { planned: 3, written: 1, skipped: 1, refused: 1, verificationFailed: 0 })
})

test('a project already inside the workspace skips the save-as and only refreshes the tree', async (t) => {
  const root = await tempWorkspace(t)
  const inside = join(root, 'tia', basename(root), 'PEI_SinoARP.ap17')
  await makeFile(inside, 'project bytes')
  const { tool, calls } = setup({ session: sessionReport({ projectPath: inside }) })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.project.skipSave, true)
  assert.deepEqual(
    operations(calls),
    ['readTiaSession', 'readPlcChecksum', 'rebuildSource', 'syncScan'],
    're-running must not save the project again',
  )
})

test('an existing source tree is announced rather than silently skipped', async (t) => {
  const root = await tempWorkspace(t)
  await mkdir(join(root, 'source'), { recursive: true })
  const { tool } = setup()

  const outcome = await executeTool(tool, {}, fakeExec(root))

  assert.ok(
    outcome.warnings.some((warning) => /already exists/u.test(warning)),
    'the caller should know that existing files will be skipped',
  )
})

test('the ignore rules are created, appended or left alone — the file is never rewritten', async (t) => {
  // Missing file: created with all three rules (the project TIA owns, the
  // databases the graph plugin derives from the source tree, and the local sync
  // state the sync tool writes and deletes).
  const fresh = await tempWorkspace(t)
  const freshOutcome = assertEnvelope(await executeTool(setup().tool, { dry_run: false }, fakeExec(fresh)))
  const created = await readFile(join(fresh, '.gitignore'), 'utf8')
  assert.match(created, /^tia\/$/mu)
  assert.match(created, /^knowledge\/\*\*\/\*\.db\*$/mu)
  assert.match(created, /^\.dsh\/local\/$/mu)
  assert.equal(freshOutcome.data.ignore.action, 'created')
  assert.deepEqual(freshOutcome.data.ignore.added, ['tia/', 'knowledge/**/*.db*', '.dsh/local/'])
  assert.deepEqual(freshOutcome.data.ignore.rules, [
    { rule: 'tia/', present: false },
    { rule: 'knowledge/**/*.db*', present: false },
    { rule: '.dsh/local/', present: false },
  ])

  // Existing file without the rules: the user's lines survive, all three rules are appended.
  const existing = await tempWorkspace(t)
  await makeFile(join(existing, '.gitignore'), 'node_modules/\n*.log\n')
  const appendedOutcome = assertEnvelope(await executeTool(setup().tool, { dry_run: false }, fakeExec(existing)))
  const appended = await readFile(join(existing, '.gitignore'), 'utf8')
  assert.match(appended, /^node_modules\/$/mu)
  assert.match(appended, /^\*\.log$/mu)
  assert.match(appended, /^tia\/$/mu)
  assert.match(appended, /^knowledge\/\*\*\/\*\.db\*$/mu)
  assert.match(appended, /^\.dsh\/local\/$/mu)
  assert.equal(appendedOutcome.data.ignore.action, 'appended')

  // Running twice must not append any rule twice, and the second run reports
  // them as present rather than as a change.
  const twiceOutcome = assertEnvelope(await executeTool(setup().tool, { dry_run: false }, fakeExec(existing)))
  const twice = await readFile(join(existing, '.gitignore'), 'utf8')
  assert.equal(twice.match(/^tia\/$/gmu).length, 1)
  assert.equal(twice.match(/^knowledge\/\*\*\/\*\.db\*$/gmu).length, 1)
  assert.equal(twice.match(/^\.dsh\/local\/$/gmu).length, 1)
  assert.equal(twiceOutcome.data.ignore.action, 'unchanged')
  assert.deepEqual(twiceOutcome.data.ignore.added, [])

  // The alternate spellings a user may have written count as present: only the
  // missing rules are added, and the file is otherwise left alone. (A user who
  // ignored the database without its SQLite side files is *not* "present": the
  // rule this plugin needs is the one that covers both.)
  const half = await tempWorkspace(t)
  await makeFile(join(half, '.gitignore'), '# mine\n/tia/\n')
  const halfOutcome = assertEnvelope(await executeTool(setup().tool, { dry_run: false }, fakeExec(half)))
  const repaired = await readFile(join(half, '.gitignore'), 'utf8')
  assert.match(repaired, /^# mine$/mu)
  assert.equal(repaired.match(/tia\//gmu).length, 1, 'the existing spelling is not duplicated')
  assert.match(repaired, /^knowledge\/\*\*\/\*\.db\*$/mu)
  assert.match(repaired, /^\.dsh\/local\/$/mu)
  assert.deepEqual(halfOutcome.data.ignore.added, ['knowledge/**/*.db*', '.dsh/local/'])

  // A workspace that already ignores the database but not its SQLite side files
  // gets the wider rule appended; the narrower line is left where the user put it.
  const narrower = await tempWorkspace(t)
  await makeFile(join(narrower, '.gitignore'), 'tia/\nknowledge/**/*.db\n.dsh/local/\n')
  const narrowerOutcome = assertEnvelope(await executeTool(setup().tool, { dry_run: false }, fakeExec(narrower)))
  const upgraded = await readFile(join(narrower, '.gitignore'), 'utf8')
  assert.match(upgraded, /^knowledge\/\*\*\/\*\.db\*$/mu)
  assert.deepEqual(narrowerOutcome.data.ignore.added, ['knowledge/**/*.db*'])
})

test('the target dirs do not depend on the project name, which is only the recorded identity', async (t) => {
  const root = await tempWorkspace(t)

  // A name with characters a filesystem rejects changes nothing about the targets.
  const odd = await executeTool(setup({ session: sessionReport({ projectName: 'A/B:C' }) }).tool, {}, fakeExec(root))
  assert.equal(odd.data.plan.projectDirectory.port, `tia/${basename(root)}`)
  assert.equal(odd.data.plan.sourceRoot.port, 'source')

  // A name is derived from the project path when TIA reports none, and the tool
  // refuses to invent one when there is nothing to derive from.
  const fallback = await executeTool(
    setup({ session: sessionReport({ projectName: null, projectPath: 'C:\\TIA\\SinoARP\\tia.ap17' }) }).tool,
    {},
    fakeExec(root),
  )
  assert.equal(fallback.ok, true)
  assert.equal(fallback.data.plan.name, 'tia')

  const nothing = await executeTool(
    setup({ session: sessionReport({ projectName: null, projectPath: null }) }).tool,
    {},
    fakeExec(root),
  )
  assert.equal(nothing.ok, false)
  assert.equal(nothing.error.code, 'project_name_unavailable')
})

test('one workspace manages one project: another project\'s tree is refused', async (t) => {
  const root = await tempWorkspace(t)
  // What an earlier run for a different project left behind.
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({ schemaVersion: 1, project: { name: 'OTHER_PROJECT' } }),
  )
  const { tool, calls } = setup()

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'source_belongs_to_another_project')
  assert.match(outcome.error.message, /OTHER_PROJECT/u)
  assert.equal(outcome.error.details.current, 'PEI_SinoARP')
  assert.deepEqual(operations(calls), ['readTiaSession'], 'nothing is written before the check')

  // The same project again is fine, and an unreadable index is only a warning.
  await makeFile(join(root, 'source', '_dsh-engineering-context.json'), '{ not json')
  const corrupted = await executeTool(setup().tool, { dry_run: false }, fakeExec(root))
  assert.equal(corrupted.ok, true)
  assert.ok(
    corrupted.warnings.some((warning) => /could not be read/u.test(warning)),
    'an index that cannot be read is reported, not ignored',
  )
})

test('TIA renaming the saved copy does not make the tool reject its own tree', async (t) => {
  const root = await tempWorkspace(t)
  // What a live session showed: the copy is saved into `tia/`, so TIA names the
  // project `tia` while the index still records the source project's name.
  const copy = join(root, 'tia', basename(root), ` ${basename(root)}.ap17`)
  await makeFile(copy, 'project bytes')
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: 'PEI_SinoARP_SWT2', path: 'C:\\src\\PEI_SinoARP_SWT2.ap17', savedAs: copy },
    }),
  )
  const { tool } = setup({ session: sessionReport({ projectName: basename(root), projectPath: copy }) })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, true, 'the recorded path identifies the project, not the name TIA rewrote')
  assert.ok(
    outcome.warnings.some((warning) => warning.includes(`TIA reports ${basename(root)} for the same project file`)),
    'the rename is reported rather than hidden',
  )
  const index = JSON.parse(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'))
  assert.equal(index.project.name, basename(root), 'the index is refreshed with the name TIA now reports')
})

test('acting on the project TIA happens to have open is flagged, not assumed', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup() // a project is open; this call names none

  const outcome = await executeTool(tool, {}, fakeExec(root))

  assert.equal(outcome.ok, true)
  assert.ok(
    outcome.warnings.some((warning) => /Nobody named a project in this call/u.test(warning)),
    'the model has to be told it is acting on a project nobody named (the failure mode of session-2cfc6894)',
  )
  assert.match(outcome.details[0], /NOBODY named this project/u)
  // Naming the project removes the flag: the caller chose it.
  const named = await executeTool(
    setup().tool,
    { source_project: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17' },
    fakeExec(root),
  )
  assert.equal(
    named.warnings.some((warning) => /Nobody named a project/u.test(warning)),
    false,
  )
})

test('a plan opens nothing at all, even when given a source project', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Line1.ap17')
  await makeFile(source, 'project bytes')
  const { tool, calls } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
  })

  const outcome = assertEnvelope(await executeTool(tool, { source_project: source, dry_run: true }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.deepEqual(operations(calls), ['readTiaSession'], 'planning must not open anything (exactly this broke a live session)')
  assert.match(outcome.summary, /would open/u)
  assert.match(outcome.details[0], /will open/u)
  await assert.rejects(stat(join(root, 'tia')), 'a plan creates nothing')
})

test('a project someone else opened stops the call with one instruction', async (t) => {
  const root = await tempWorkspace(t)
  const named = join(root, 'Line1.ap17')
  await makeFile(named, 'project bytes')

  // (a) the controller can see the other project, so the tool refuses before asking TIA.
  const seen = setup() // session: PEI_SinoARP is open elsewhere
  const refused = await executeTool(seen.tool, { source_project: named, dry_run: false }, fakeExec(root))
  assert.equal(refused.error.code, 'project_already_open')
  assert.match(refused.error.message, /close that project in TIA Portal/u)
  assert.match(refused.error.message, /call this tool again once it is closed/u)
  assert.deepEqual(operations(seen.calls), ['readTiaSession'], 'no open attempt, no investigation')

  // (b) the controller cannot see it and TIA refuses: same code, same instruction.
  const hidden = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: false,
      error: { code: 'project_already_open', message: 'A project is already open (x). Close it first with CloseProject.' },
      summary: '',
      data: null,
    },
  })
  const bounced = await executeTool(hidden.tool, { source_project: named, dry_run: false }, fakeExec(root))
  assert.equal(bounced.error.code, 'project_already_open', 'not a generic open_failed: the answer is "close it"')
  assert.match(bounced.error.message, /Tell the user to close the project that is open/u)
  assert.match(bounced.error.message, /Do not investigate process/u)
  assert.deepEqual(operations(hidden.calls), ['readTiaSession', 'openProject'])
})

test('a transport failure is reported as data, and the workspace is left alone', async (t) => {
  const root = await tempWorkspace(t)

  const unreadable = await executeTool(setup({ readThrows: new Error('controller_not_found') }).tool, {}, fakeExec(root))
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.code, 'tia_unreachable')
  assert.match(unreadable.error.message, /controller_not_found/u)

  const { tool, calls } = setup({ saveThrows: new Error('controller_timeout') })
  const unsaved = await executeTool(tool, { dry_run: false }, fakeExec(root))
  assert.equal(unsaved.ok, false)
  assert.equal(unsaved.error.code, 'tia_unreachable')
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum', 'saveProjectAs'])
  await assert.rejects(stat(join(root, '.gitignore')))
})

test('a session without a working directory fails closed', async () => {
  const { tool } = setup()

  for (const exec of [fakeExec(undefined), fakeExecWithoutCwd()]) {
    const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, exec))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'scope_unavailable')
    assert.equal(outcome.scope, null)
  }
})

test('the knowledge graph is rebuilt once per device, after the export', async (t) => {
  const root = await tempWorkspace(t)
  const graph = fakeKnowledgeGraph()
  const { tool, calls } = setup({ knowledgeGraph: graph })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  // The TIA half is unchanged and still ordered checksum → save → export → evidence.
  assert.deepEqual(operations(calls), [
    'readTiaSession',
    'readPlcChecksum',
    'saveProjectAs',
    'rebuildSource',
    'syncScan',
  ])
  // The graph half runs per device, against the directory the export reported.
  assert.deepEqual(
    graph.calls.map((call) => (call.operation === 'status' ? 'status' : call.deviceDir)),
    ['status', join(root, 'source', 'S7-1500')],
  )
  assert.equal(graph.calls[1].options.dbPath, undefined, 'the graph plugin owns the database convention')

  assert.equal(outcome.data.knowledge.state, 'ingested')
  assert.equal(outcome.data.knowledge.available, true)
  assert.deepEqual(outcome.data.knowledge.totals, { devices: 1, ok: 1, filesFound: 2, filesImported: 2, nodes: 72, edges: 153 })
  assert.equal(outcome.data.knowledge.devices[0].dbPath, join(root, 'knowledge', 'S7-1500', 'S7-1500_knowledge.db'))
  assert.match(outcome.summary, /Rebuilt the knowledge graph for 1 device/u)
  assert.match(renderedText(tool, {}, outcome), /Knowledge graph: S7-1500 → knowledge\/S7-1500\/S7-1500_knowledge\.db/u)
})

test('a composition without the graph plugin still creates the project', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup()

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true, 'a missing optional plugin is not a workflow failure')
  assert.equal(outcome.data.knowledge.state, 'absent')
  assert.equal(outcome.data.knowledge.available, false)
  assert.match(outcome.summary, /knowledge graph was not built/u)
  assert.ok(outcome.warnings.some((warning) => /knowledgeGraph service/u.test(warning)))
  assert.match(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'), /S7-1500/u)
})

test('an engine that is not built is reported without asking it to ingest', async (t) => {
  const root = await tempWorkspace(t)
  const graph = fakeKnowledgeGraph({
    status: { available: false, reason: 'the knowledge engine was not found at X', enginePath: 'X', engineExists: false, source: 'package', databaseConvention: null },
  })
  const { tool } = setup({ knowledgeGraph: graph })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.state, 'unavailable')
  assert.deepEqual(graph.calls.map((call) => call.operation), ['status'])
  assert.deepEqual(outcome.data.knowledge.notAttempted, ['S7-1500'])
  assert.match(outcome.summary, /knowledge graph was not built/u)
  assert.ok(outcome.warnings.some((warning) => /not built: the knowledge engine was not found at X/u.test(warning)))
})

test('a graph refusal is data: the code and the remediation reach the result', async (t) => {
  const root = await tempWorkspace(t)
  const graph = fakeKnowledgeGraph({
    ingest: () => ({
      ok: false,
      operation: 'Ingest',
      dryRun: false,
      summary: 'Ingest was refused.',
      data: null,
      changes: [],
      diagnostics: [],
      error: { code: 'NO_SOURCE_FILES', message: 'nothing importable was found', details: { remediation: 'run the export again' } },
      durationMs: 4,
    }),
  })
  const { tool } = setup({ knowledgeGraph: graph })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true, 'the source tree was exported; the graph refusal does not undo it')
  assert.equal(outcome.data.knowledge.state, 'failed')
  assert.equal(outcome.data.knowledge.devices[0].error.code, 'NO_SOURCE_FILES')
  assert.equal(outcome.data.knowledge.devices[0].error.remediation, 'run the export again')
  assert.ok(
    outcome.warnings.some((warning) => /NO_SOURCE_FILES/u.test(warning) && /run the export again/u.test(warning)),
    'the next step the engine named has to be visible',
  )
})

test('a knowledge engine that cannot be reached degrades instead of failing the workflow', async (t) => {
  const root = await tempWorkspace(t)
  const graph = fakeKnowledgeGraph({ ingestThrows: new Error('engine_timeout: no answer') })
  const { tool } = setup({ knowledgeGraph: graph })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.knowledge.state, 'unavailable')
  assert.equal(outcome.data.knowledge.available, false)
  assert.match(outcome.data.knowledge.reason, /engine_timeout/u)
  assert.ok(outcome.warnings.some((warning) => /engine failed/u.test(warning)))
  assert.ok(outcome.warnings.some((warning) => /source tree is unaffected|exported source tree is unaffected/u.test(warning)))
})

test('the graph is refreshed even when every source file was already present', async (t) => {
  const root = await tempWorkspace(t)
  // The "nothing was written" path: the ordinary re-run that has to refresh the
  // graph, because a full rebuild is the only refresh this graph has.
  const inside = join(root, 'tia', basename(root), 'PEI_SinoARP.ap17')
  await makeFile(inside, 'project bytes')
  const sourceRoot = join(root, 'source')
  const graph = fakeKnowledgeGraph()
  const { tool } = setup({
    session: sessionReport({ projectPath: inside }),
    knowledgeGraph: graph,
    rebuild: {
      ok: false,
      error: { code: 'export_failed', message: 'No object could be exported: Openness refused all 4 object(s).' },
      summary: '',
      sourceRoot,
      devices: [],
      failures: [],
      missingDevices: [],
      data: { counts: { blocks: 0, types: 3, tagTables: 1 }, summary: { exported: 0, skipped: 4, failed: 0, verificationFailed: 0 } },
    },
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.data.rebuild.nothingWritten, true)
  // No device directory was reported, so there is nothing to ingest — but the
  // step still ran and said so.
  assert.equal(outcome.data.knowledge.state, 'empty')
  assert.deepEqual(graph.calls.map((call) => call.operation), ['status'])
})

test('a plan names the graph step and asks the graph service for nothing', async (t) => {
  const root = await tempWorkspace(t)
  const graph = fakeKnowledgeGraph()
  const { tool } = setup({ knowledgeGraph: graph })

  const outcome = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))

  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.knowledge, null)
  assert.deepEqual(graph.calls, [], 'planning must not touch the graph service')
  assert.match(outcome.details.join('\n'), /Knowledge graph: after the export/u)
})

// ---------------------------------------------------------------------------
// B2 — a true one-shot import: git preflight, compile preflight, evidence
// adoption, one baseline commit
// ---------------------------------------------------------------------------

/** The four trailers a baseline commit must carry. */
function assertBaselineTrailers(message, { checksum = 'CHECKSUM-1', stateId = 'state-create' } = {}) {
  assert.match(message, /^Tia-Op: create$/mu)
  assert.match(message, new RegExp(`^Tia-Checksum: ${checksum}$`, 'mu'))
  assert.match(message, new RegExp(`^Tia-State: ${stateId}$`, 'mu'))
  assert.match(message, /^Tia-Manifest: rebuilt$/mu)
}

/** Run one tool against a context carrying exactly these services. */
function toolWithServices(services, config = {}) {
  const { ctx } = createTestContext({ services })
  return findTool(toolDefinitions({ ctx, config: resolveConfig(config), log: ctx.logger }), TOOL)
}

test('a composition without gitContext refuses with git_access_unavailable', async (t) => {
  const root = await tempWorkspace(t)
  const { service } = fakeAccess()
  const tool = toolWithServices({ engineeringAccess: service })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'git_access_unavailable')
  assert.match(outcome.error.message, /gitContext/u)
})

test('a fresh workspace is initialized and gets exactly one baseline commit', async (t) => {
  const root = await tempWorkspace(t)

  // The plan says what git will do, and writes nothing at all.
  const planned = setup()
  const plan = assertEnvelope(await executeTool(planned.tool, {}, fakeExec(root)))
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.data.plan.git, { state: 'none', initialize: true, repoRoot: null, baselineCommit: true })
  assert.match(plan.details.join('\n'), /not a repository yet/u)

  const { tool, calls, git } = setup()
  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))
  assert.equal(outcome.ok, true)

  const init = git.find((call) => call.operation === 'init')
  assert.ok(init, 'a fresh workspace is initialized through the service, not by this plugin')
  assert.equal(init.root, root)

  const commits = git.filter((call) => call.operation === 'commit')
  assert.equal(commits.length, 1, 'one baseline commit for the whole import')
  assert.deepEqual(
    commits[0].paths,
    ['.gitignore', '.gitattributes', 'source'],
    'exactly the three paths; source/ carries the index written before the commit',
  )
  assertBaselineTrailers(commits[0].message)
  assert.match(commits[0].message, /^create: PEI_SinoARP/u)

  assert.deepEqual(outcome.data.git, { root, initialized: true, committed: true, hash: '0123456789abcdef' })
  assert.equal(outcome.data.gitAttributes.action, 'created')
  assert.equal(outcome.data.gitAttributes.rule, 'source/** -text')
  assert.match(await readFile(join(root, '.gitattributes'), 'utf8'), /^source\/\*\* -text$/mu)

  const marker = JSON.parse(await readFile(join(root, '.dsh', 'local', 'repo.json'), 'utf8'))
  assert.deepEqual(marker, { schemaVersion: 1, createdBy: 'engineering-context' })
  assert.match(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'), /PEI_SinoARP/u)
  assert.deepEqual(operations(calls), [
    'readTiaSession',
    'readPlcChecksum',
    'saveProjectAs',
    'rebuildSource',
    'syncScan',
  ])
})

test('a workspace inside a foreign repository is refused before TIA is asked anything', async (t) => {
  const root = await tempWorkspace(t)
  const parent = dirname(root)
  const foreign = fakeGitContext({ repoRoot: parent })
  const { tool, calls } = setup({ gitContext: foreign })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'workspace_is_repository')
  assert.match(outcome.error.message, /foreign repository/u)
  assert.match(outcome.error.message, /standalone directory/u)
  assert.equal(outcome.error.details.repoRoot, parent)
  assert.deepEqual(operations(calls), [], 'no readTiaSession, no open, no save')
  assert.deepEqual(foreign.calls.map((call) => call.operation), ['repoRoot'], 'the repository is the only thing probed')
  for (const file of ['.gitignore', '.gitattributes', join('source'), join('.dsh')]) {
    await assert.rejects(stat(join(root, file)), `${file} must not be written`)
  }

  // The plan (default) refuses identically: the check runs before anything else.
  const planned = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))
  assert.equal(planned.ok, false)
  assert.equal(planned.error.code, 'workspace_is_repository')
})

test('a repository rooted here that this plugin cannot attribute is refused', async (t) => {
  const root = await tempWorkspace(t)
  const unowned = fakeGitContext({ repoRoot: root }) // no marker, no Tia-Op: create
  const { tool, calls } = setup({ gitContext: unowned })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'workspace_is_repository')
  assert.match(outcome.error.message, /cannot attribute/u)
  assert.equal(outcome.error.details.marker, '.dsh/local/repo.json')
  assert.deepEqual(operations(calls), [])
  await assert.rejects(stat(join(root, '.gitattributes')))
})

test('a repository this plugin created is reused, and a refresh is allowed', async (t) => {
  const root = await tempWorkspace(t)
  const body =
    'create: PEI_SinoARP — baseline import\n\nTia-Op: create\nTia-Checksum: OLD\nTia-State: old\nTia-Manifest: rebuilt\n'
  const own = fakeGitContext({ repoRoot: root, commitBody: body })
  const { tool } = setup({ gitContext: own })

  const first = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))
  assert.equal(first.ok, true)
  assert.equal(first.data.git.initialized, false, 'an existing repository is never re-initialized')
  assert.equal(own.calls.filter((call) => call.operation === 'init').length, 0)
  assert.equal(own.calls.filter((call) => call.operation === 'commit').length, 1)

  // The second call is the refresh path: the marker the first one wrote (and the
  // trailer in the history) keep the repository recognizable as this plugin's.
  const second = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))
  assert.equal(second.ok, true)
  assert.equal(second.data.git.initialized, false)
  assert.equal(own.calls.filter((call) => call.operation === 'commit').length, 2)

  // The trailer alone is enough: a fresh clone has no local marker, only history.
  const markerless = fakeGitContext({ repoRoot: root, commitBody: body })
  const third = assertEnvelope(await executeTool(setup({ gitContext: markerless }).tool, {}, fakeExec(root)))
  assert.equal(third.ok, true, 'Tia-Op: create identifies the repository without the marker')
  assert.equal(third.data.plan.git.initialize, false)
})

test('an uncompiled PLC refuses before the save-as and the export', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls, git } = setup({
    checksum: { ok: false, error: { code: 'checksum_unavailable', message: 'not compiled' }, summary: 'no checksum' },
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'needs_compile')
  assert.match(outcome.error.message, /Compile it in TIA Portal/u)
  assert.match(outcome.error.message, /call create_engineering_project again/u)
  assert.deepEqual(operations(calls), ['readTiaSession', 'readPlcChecksum'], 'nothing is saved or exported')
  assert.equal(git.filter((call) => call.operation === 'commit').length, 0)
  for (const file of ['.gitignore', '.gitattributes', join('source'), join('tia')]) {
    await assert.rejects(stat(join(root, file)), `${file} must not be written`)
  }

  // `ok: true` with an empty checksum is the same state, not a success.
  const empty = setup({ checksum: { ok: true, summary: 'read', data: { checksum: null } } })
  const emptyOutcome = assertEnvelope(await executeTool(empty.tool, { dry_run: false }, fakeExec(root)))
  assert.equal(emptyOutcome.error.code, 'needs_compile')

  // A plugin without the method is a coded absence, not a compile failure.
  const bare = fakeAccess().service
  delete bare.readPlcChecksum
  const noMethod = toolWithServices({
    engineeringAccess: bare,
    gitContext: fakeGitContext().service,
  })
  const unavailable = assertEnvelope(await executeTool(noMethod, { dry_run: false }, fakeExec(root)))
  assert.equal(unavailable.error.code, 'tia_access_unavailable')
  assert.match(unavailable.error.message, /readPlcChecksum/u)
})

test('the evidence pass adopts the exported tree, copies both documents and removes STAGE', async (t) => {
  const root = await tempWorkspace(t)
  const adopted = {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: 'S7-1500',
    software: 'PLC_1',
    plcChecksum: 'CHECKSUM-1',
    stateId: 'state-adopt',
    objects: {},
    unexportable: [],
    tombstones: [],
  }
  const { tool, calls, git } = setup({
    scan: async (query) => {
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB1.xml'), '<xml>FB1</xml>')
      await makeFile(join(query.stageDir, 'blocks', '010', 'FB2.xml'), '<xml>FB2</xml>')
      const evidence = join(query.stageDir, '_evidence.json')
      const manifest = join(query.stageDir, '_manifest.json')
      await makeFile(evidence, `${JSON.stringify(adopted, null, 2)}\n`)
      await makeFile(manifest, '{"files":{"blocks/010/FB1.xml":{}}}\n')
      return {
        ok: true,
        summary: 'scan complete',
        data: {
          checksum: 'CHECKSUM-1',
          unchanged: false,
          manifestRebuilt: true,
          counts: { blocks: 2, types: 1, tagTables: 1, changed: 0, added: 0, removed: 0, unexportable: 0 },
          changed: [],
          added: [],
          removed: [],
          unexportable: [],
          stage: { root: query.stageDir, evidence, manifest, files: 2 },
          stateId: 'state-adopt',
          adopted: 2,
        },
      }
    },
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))
  assert.equal(outcome.ok, true)

  const scan = calls.find((call) => call.operation === 'syncScan')
  assert.equal(scan.query.adoptExisting, true, 'the controller must adopt, not export the tree twice')
  assert.equal(scan.query.sourceRoot, join(root, 'source', 'S7-1500'), 'manifest entries are relative to the device directory')
  assert.equal(scan.query.evidencePath, join(root, 'source', 'S7-1500', '_evidence.json'))
  assert.equal(scan.query.manifestPath, join(root, 'source', 'S7-1500', '_manifest.json'))

  const device = join(root, 'source', 'S7-1500')
  assert.deepEqual(JSON.parse(await readFile(join(device, '_evidence.json'), 'utf8')), adopted)
  assert.match(await readFile(join(device, '_manifest.json'), 'utf8'), /FB1\.xml/u)

  assert.equal((await readdir(join(root, '.dsh', 'local', 'stage'))).length, 0, 'STAGE is scratch space')
  assert.equal(outcome.data.evidence.length, 1)
  assert.equal(outcome.data.evidence[0].exported, 2)
  assert.equal(outcome.data.evidence[0].adopted, 2)
  assert.equal(outcome.data.evidence[0].evidence, 'source/S7-1500/_evidence.json')
  assert.match(outcome.details.join('\n'), /Evidence S7-1500\/PLC_1: 2 exported, 2 adopted/u)

  const commit = git.find((call) => call.operation === 'commit')
  assertBaselineTrailers(commit.message, { stateId: 'state-adopt' })
})

test('a scan that cannot produce a fresh ledger is a coded failure, not a silent commit', async (t) => {
  // A PLC edited after the preflight: the scan itself reports no compiled checksum.
  const uncompiled = await tempWorkspace(t)
  const noChecksum = setup({
    scan: { ok: false, error: { code: 'checksum_unavailable', message: 'not compiled' }, summary: 'no checksum' },
  })
  const compile = assertEnvelope(await executeTool(noChecksum.tool, { dry_run: false }, fakeExec(uncompiled)))
  assert.equal(compile.error.code, 'needs_compile')
  assert.match(compile.error.message, /will be adopted/u)
  assert.equal(noChecksum.git.filter((call) => call.operation === 'commit').length, 0)
  await assert.rejects(stat(join(uncompiled, 'source', 'S7-1500', '_evidence.json')))

  // A success that wrote no STAGE has to be an error: there is no fresh ledger.
  const noStage = await tempWorkspace(t)
  const withoutStage = setup({
    scan: { ok: true, summary: 'claimed success', data: { checksum: 'CHECKSUM-1', unchanged: true, stage: null } },
  })
  const missing = assertEnvelope(await executeTool(withoutStage.tool, { dry_run: false }, fakeExec(noStage)))
  assert.equal(missing.error.code, 'sync_failed')
  assert.match(missing.error.message, /no fresh evidence ledger/u)
  assert.equal(withoutStage.git.filter((call) => call.operation === 'commit').length, 0)

  // A scan that refuses for another reason is `sync_failed`, and STAGE is gone.
  const refused = await tempWorkspace(t)
  const failed = setup({
    scan: { ok: false, error: { code: 'export_failed', message: 'boom' }, summary: 'scan refused' },
  })
  const refusedOutcome = assertEnvelope(await executeTool(failed.tool, { dry_run: false }, fakeExec(refused)))
  assert.equal(refusedOutcome.error.code, 'sync_failed')
  assert.match(refusedOutcome.error.message, /scan refused/u)
  assert.equal((await readdir(join(refused, '.dsh', 'local', 'stage'))).length, 0)
  assert.equal(failed.git.filter((call) => call.operation === 'commit').length, 0)

  // A transport failure from the scan is data too, with the STAGE directory named.
  const thrown = await tempWorkspace(t)
  const broken = setup({ scanThrows: new Error('controller_timeout') })
  const brokenOutcome = assertEnvelope(await executeTool(broken.tool, { dry_run: false }, fakeExec(thrown)))
  assert.equal(brokenOutcome.error.code, 'sync_failed')
  assert.match(brokenOutcome.error.message, /controller_timeout/u)
  assert.equal((await readdir(join(thrown, '.dsh', 'local', 'stage'))).length, 0)
})

test('a git commit failure is surfaced as git_failed and never claims a baseline', async (t) => {
  const root = await tempWorkspace(t)
  const broken = fakeGitContext({ commitThrows: new Error('fatal: unable to write commit') })
  const { tool, git } = setup({ gitContext: broken })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'git_failed')
  assert.match(outcome.error.message, /unable to write commit/u)
  assert.match(outcome.error.message, /already written/u)
  assert.equal(outcome.error.details.sourceRoot, 'source')
  assert.ok(
    outcome.error.details.evidence.includes('source/S7-1500/_evidence.json'),
    'the failure names the ledgers that ARE on disk',
  )
  assert.equal(outcome.data, null)
  assert.match(outcome.summary, /^git_failed:/u)
  assert.equal(git.filter((call) => call.operation === 'commit').length, 1)

  // Everything the import wrote is still there, and the marker was written first,
  // so a retry is allowed instead of being refused as a foreign repository.
  assert.match(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'), /PEI_SinoARP/u)
  assert.match(await readFile(join(root, 'source', 'S7-1500', '_evidence.json'), 'utf8'), /CHECKSUM-1/u)
  assert.match(await readFile(join(root, '.gitattributes'), 'utf8'), /source\/\*\* -text/u)
  assert.deepEqual(JSON.parse(await readFile(join(root, '.dsh', 'local', 'repo.json'), 'utf8')), {
    schemaVersion: 1,
    createdBy: 'engineering-context',
  })

  const retryGit = fakeGitContext({ repoRoot: root, commitBody: null })
  const retry = assertEnvelope(await executeTool(setup({ gitContext: retryGit }).tool, { dry_run: false }, fakeExec(root)))
  assert.equal(retry.ok, true, 'the marker makes the retry possible')
  assert.equal(retry.data.git.initialized, false)
})

test('git init itself failing is git_failed, with the paths that were already written', async (t) => {
  const root = await tempWorkspace(t)
  const broken = fakeGitContext({ initThrows: new Error('fatal: cannot create repository') })
  const { tool } = setup({ gitContext: broken })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'git_failed')
  assert.match(outcome.error.message, /cannot create repository/u)
  assert.equal(outcome.error.details.initialized, true)
  assert.ok(outcome.error.details.evidence.length > 0)
  // The marker is written before init, so even this failure is retryable.
  assert.deepEqual(JSON.parse(await readFile(join(root, '.dsh', 'local', 'repo.json'), 'utf8')), {
    schemaVersion: 1,
    createdBy: 'engineering-context',
  })
})

