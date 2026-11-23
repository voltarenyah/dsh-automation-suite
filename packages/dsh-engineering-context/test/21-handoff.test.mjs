/**
 * The handoff workflow: marker, archive preflight, export and import.
 *
 * TIA is a fake (the controller cannot run in this test environment), but the
 * workspace, the git repository, the ZIP archive and the project folder are real.
 * That is enough to hold down the parts that can actually lose a project:
 *
 * - the marker is built from the committed evidence and is readable from the
 *   archive before TIA is touched;
 * - export refuses a project outside `tia/<workspace>/` and a dirty source tree,
 *   writes the marker into `UserFiles/`, archives, reads it back, and only then
 *   records the package;
 * - import refuses an advanced HEAD, verifies the marker against git, moves the
 *   old project aside, retrieves, and stops at `awaiting_compile` instead of
 *   guessing;
 * - the record/status surface points at the visible `handoff/` directory.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { strToU8, unzipSync, zipSync } from 'fflate'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadConfigModule,
  loadHandoffEntryModule,
  loadHandoffMarkerModule,
  loadHandoffZipModule,
  loadToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { resolveConfig } = await loadConfigModule()
const handoffEntry = await loadHandoffEntryModule()
const execFileAsync = promisify(execFile)

const DEVICE = 'PLC1'
const SOFTWARE = 'SW1'
const PROJECT = 'HandoffProject'
const AP17 = `<?xml version="1.0" encoding="utf-8"?>
<Data Type="Project" Name="${PROJECT}" ProjectCompatibilityVersion="17.0.0.0" xmlns="http://www.siemens.com/2007/07/Automation/CommonServices/DataInfoValueData" />`

/** The same project XML under another TIA project name. */
function ap17Named(name) {
  return AP17.replace(`Name="${PROJECT}"`, `Name="${name}"`)
}

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
}

async function gitWorkspace(t) {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Handoff Test'])
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

function evidenceDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'xml-norm-v1',
    device: DEVICE,
    software: SOFTWARE,
    plcChecksum: 'AA BB',
    stateId: 'sha256:0123456789abcdef',
    safetyRecorded: false,
    objects: {
      [`blocks||FB1`]: {
        key: 'blocks||FB1',
        category: 'blocks',
        name: 'FB1',
        group: '',
        path: 'blocks/FB1.xml',
        fingerprint: { Code: 'code-a', Interface: 'if-a', Comments: 'c-a' },
        isSafetyBlock: true,
        safetySignature: { type: 'BlockOfflineSignature', value: 12345 },
      },
    },
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
}

function sourceIndex(root, projectPath) {
  const tiaDir = join(root, 'tia', basename(root))
  return {
    schemaVersion: 1,
    project: {
      name: PROJECT,
      path: null,
      savedAs: projectPath,
      archive: null,
      directory: `tia/${basename(root)}`,
      sourceRoot: 'source',
    },
    exportedAt: new Date(0).toISOString(),
    devices: [
      {
        device: DEVICE,
        software: SOFTWARE,
        directory: join(root, 'source', DEVICE),
        manifest: join(root, 'source', DEVICE, '_manifest.json'),
        exported: { blocks: 1, types: 0, tagTables: 0 },
        skipped: 0,
      },
    ],
    totals: { planned: 1, written: 1, skipped: 0, refused: 0, verificationFailed: 0 },
    _tiaDir: tiaDir,
  }
}

/** A workspace with one committed project and evidence ledger. */
async function seededWorkspace(t) {
  const root = await gitWorkspace(t)
  const projectDir = join(root, 'tia', basename(root))
  const projectPath = join(projectDir, `${PROJECT}.ap17`)
  const deviceDir = join(root, 'source', DEVICE)
  await makeFile(projectPath, AP17)
  await makeFile(join(deviceDir, '_evidence.json'), `${JSON.stringify(evidenceDocument(), null, 2)}\n`)
  await makeFile(join(deviceDir, '_manifest.json'), '{}\n')
  await makeFile(join(root, 'source', '_dsh-engineering-context.json'), `${JSON.stringify(sourceIndex(root, projectPath), null, 2)}\n`)
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'baseline'])
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
  return { root, projectDir, projectPath, deviceDir, head }
}

/** A fake engineeringAccess with a mutable open-project state. */
function fakeAccess({ projectPath, checksum = 'AA BB', onChange, fullScanClean = false, retrievedName = PROJECT } = {}) {
  const state = { projectPath, projectName: PROJECT, closed: 0, retrieved: 0, checked: 0 }
  const software = [{ device: DEVICE, software: SOFTWARE, blockCount: 1 }]
  const session = () => ({
    running: true,
    projectOpen: state.projectPath !== null,
    projectName: state.projectName,
    projectPath: state.projectPath,
    isModified: false,
    software,
    reason: null,
  })
  return {
    state,
    service: {
      async readTiaSession() {
        return session()
      },
      async closeProject() {
        state.closed += 1
        state.projectPath = null
        return { ok: true, summary: 'closed' }
      },
      async openProject() {
        return { ok: true, summary: 'opened' }
      },
      async saveProjectAs() {
        return { ok: true, summary: 'saved' }
      },
      async rebuildSource() {
        return { ok: false, summary: 'not used', error: { code: 'not_used', message: 'not used' } }
      },
      async retrieveProject(_archive, target) {
        state.retrieved += 1
        state.projectName = retrievedName
        state.projectPath = join(target, retrievedName, `${retrievedName}.ap17`)
        await mkdir(dirname(state.projectPath), { recursive: true })
        await writeFile(state.projectPath, ap17Named(retrievedName), 'utf8')
        if (onChange) await onChange(state.projectPath)
        return {
          ok: true,
          summary: 'retrieved',
          data: {
            projectName: retrievedName,
            projectPath: state.projectPath,
            targetDir: target,
            archivePath: _archive,
            upgraded: false,
            plcSoftware: software,
          },
        }
      },
      async readPlcChecksum() {
        state.checked += 1
        if (checksum === null) {
          return { ok: false, summary: 'not compiled', error: { code: 'checksum_unavailable', message: 'compile first' } }
        }
        return { ok: true, summary: 'checksum', data: { checksum, device: DEVICE, software: SOFTWARE } }
      },
      async syncScan(query) {
        if (fullScanClean) {
          // Reproduce the controller's real full-scan path: it ran, it found
          // nothing, and it still reports `unchanged:false` with a STAGE ledger.
          await mkdir(query.stageDir, { recursive: true })
          const evidence = await readFile(join(query.sourceRoot, '_evidence.json'), 'utf8')
          const manifest = await readFile(join(query.sourceRoot, '_manifest.json'), 'utf8')
          const stageEvidence = join(query.stageDir, '_evidence.json')
          const stageManifest = join(query.stageDir, '_manifest.json')
          await writeFile(stageEvidence, evidence)
          await writeFile(stageManifest, manifest)
          return {
            ok: true,
            summary: 'full scan: 0 changed',
            data: {
              checksum,
              unchanged: false,
              scanSkipped: false,
              manifestRebuilt: true,
              counts: { blocks: 1, types: 0, tagTables: 0, changed: 0, added: 0, removed: 0, unexportable: 0 },
              changed: [],
              added: [],
              removed: [],
              unexportable: [],
              stage: { root: query.stageDir, evidence: stageEvidence, manifest: stageManifest, files: 0 },
              stateId: 'sha256:0123456789abcdef',
              adopted: 0,
            },
          }
        }
        return {
          ok: true,
          summary: 'unchanged',
          data: {
            checksum,
            unchanged: true,
            scanSkipped: false,
            manifestRebuilt: false,
            counts: { blocks: 1, types: 0, tagTables: 0, changed: 0, added: 0, removed: 0, unexportable: 0 },
            changed: [],
            added: [],
            removed: [],
            unexportable: [],
            stateId: 'sha256:0123456789abcdef',
            adopted: 0,
          },
        }
      },
    },
  }
}

/** A fake projectTextAccess that writes a real ZIP with the marker and .ap17. */
function fakeTextAccess({ projectPath, ap17Text = AP17 }) {
  return {
    async archiveProject({ targetDir, targetName }) {
      const marker = await readFile(join(dirname(projectPath), 'UserFiles', '_dsh-handoff.json'), 'utf8')
      const archive = zipSync({
        [`${PROJECT}.ap17`]: strToU8(ap17Text),
        'UserFiles/_dsh-handoff.json': strToU8(marker),
      })
      const file = join(targetDir, targetName)
      await mkdir(targetDir, { recursive: true })
      await writeFile(file, archive)
      return { ok: true, summary: 'archived', data: { archivedPath: file, targetDir, targetName, mode: 'compressed' } }
    },
    async saveProject() {
      return { ok: true, summary: 'saved' }
    },
  }
}

/** Rewrite an exported archive as if TIA had renamed the project on the other machine. */
async function renamedArchive(root, exportedRecord, name) {
  const source = join(root, exportedRecord.archive.path)
  const files = unzipSync(await readFile(source))
  const renamed = {}
  for (const [entry, bytes] of Object.entries(files)) {
    if (!entry.toLowerCase().endsWith('.ap17')) renamed[entry] = bytes
  }
  renamed[`${name}.ap17`] = strToU8(ap17Named(name))
  const target = join(root, 'handoff', exportedRecord.handoffId, `${name}_returned.zap17`)
  await writeFile(target, zipSync(renamed))
  return target
}

function toolFor(service, textAccess, config = resolveConfig()) {
  const { ctx, definitions } = createTestContext({
    services: { engineeringAccess: service, projectTextAccess: textAccess },
  })
  handoffEntry.apply(ctx)
  return (name) => findTool(definitions, name)
}

test('marker and zip utilities: build, round-trip, read back from a real ZIP', async (t) => {
  const root = await tempWorkspace(t)
  const evidence = evidenceDocument()
  const { buildMarker, markerText, parseMarker, sourceIdentityOf } = await loadHandoffMarkerModule()
  const marker = buildMarker({
    handoffId: '20261119T1330-7f3a',
    createdAt: '2026-11-19T05:30:00.000Z',
    head: 'a'.repeat(40),
    branch: 'main',
    projectName: PROJECT,
    tiaVersion: '17.0.0.0',
    devices: [{ device: DEVICE, software: SOFTWARE, evidence }],
  })
  assert.equal(marker.devices[0].objectCount, 1)
  assert.match(marker.devices[0].sourceIdentity, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(parseMarker(markerText(marker), 'test').handoffId, marker.handoffId)
  assert.equal(sourceIdentityOf(evidence), marker.devices[0].sourceIdentity)

  const archive = join(root, 'x.zap17')
  await writeFile(archive, zipSync({
    [`${PROJECT}.ap17`]: strToU8(AP17),
    'UserFiles/_dsh-handoff.json': strToU8(markerText(marker)),
    'AdditionalFiles/x.txt': strToU8('ignored'),
  }))
  const { readArchive, parseAp17Identity } = await loadHandoffZipModule()
  const read = await readArchive(archive)
  assert.equal(read.marker?.entry, 'UserFiles/_dsh-handoff.json')
  assert.equal(read.project?.entry, `${PROJECT}.ap17`)
  assert.deepEqual(parseAp17Identity(read.project.text, read.project.entry), {
    name: PROJECT,
    tiaVersion: '17.0.0.0',
    majorVersion: 17,
  })
})

test('handoff_status lists packages and their archive/backup state', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const id = '20261119T1330-7f3a'
  const archive = join(root, 'handoff', id, `${PROJECT}_20261119-1330.zap17`)
  await makeFile(archive, 'zip')
  const record = {
    schemaVersion: 1,
    kind: 'dsh-tia-handoff-record',
    handoffId: id,
    status: 'issued',
    createdAt: '2026-11-19T05:30:00.000Z',
    workspace: basename(root),
    base: { commit: 'a'.repeat(40), branch: 'main', sourceClean: true },
    project: { name: PROJECT, tiaVersion: '17.0.0.0', device: DEVICE, software: SOFTWARE },
    archive: { path: `handoff/${id}/${basename(archive)}`, sha256: '0'.repeat(64), bytes: 3, mode: 'compressed' },
    marker: { path: `handoff/${id}/marker.json`, sha256: '1'.repeat(64) },
    backup: null,
    returned: null,
    import: null,
  }
  await makeFile(join(root, 'handoff', id, 'handoff.json'), `${JSON.stringify(record, null, 2)}\n`)
  const access = fakeAccess({ projectPath })
  const tool = toolFor(access.service, undefined)('handoff_status')
  const outcome = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.count, 1)
  assert.equal(outcome.data.handoffs[0].handoffId, id)
  assert.equal(outcome.data.handoffs[0].archive.present, true)

  // The Leader's normal pre-dispatch status already carries the handoff summary.
  const { toolDefinitions } = await loadToolsModule()
  const { ctx } = createTestContext({ services: { engineeringAccess: access.service } })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
  const statusTool = findTool(definitions, 'project_status')
  const status = assertEnvelope(await executeTool(statusTool, {}, fakeExec(root)))
  assert.equal(status.ok, true)
  assert.equal(status.data.handoffs.total, 1)
  assert.equal(status.data.handoffs.outstanding, 1)
  assert.equal(status.data.handoffs.awaitingCompile, 0)
  assert.match(status.details.join('\n'), /Handoff:/u)
})

test('handoff_export dry run reports the base and the package without writing', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath })
  const tool = toolFor(access.service, fakeTextAccess({ projectPath }))('handoff_export')
  const outcome = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.plan.base.commit, (await git(root, ['rev-parse', 'HEAD'])).stdout.trim())
  assert.equal(outcome.data.plan.project.projectPath, projectPath)
  assert.equal(await exists(join(root, 'handoff')), false)
  assert.equal(await exists(join(dirname(projectPath), 'UserFiles')), false)
})

test('handoff_export run writes the marker, the archive and a readable record', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath })
  const texts = fakeTextAccess({ projectPath })
  const tool = toolFor(access.service, texts)('handoff_export')
  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))
  assert.equal(outcome.ok, true)
  const record = outcome.data.record
  assert.equal(record.status, 'issued')
  assert.match(record.archive.path, /^handoff\/.+\/HandoffProject_\d{8}-\d{4}\.zap17$/u)
  assert.equal(await exists(join(root, record.archive.path)), true)
  assert.equal(await exists(join(root, record.marker.path)), true)
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^handoff\/$/mu)
  const marker = await readFile(join(dirname(projectPath), 'UserFiles', '_dsh-handoff.json'), 'utf8')
  assert.match(marker, /"kind": "dsh-tia-handoff"/u)
})

test('handoff_export accepts a forced full scan that found zero changes', async (t) => {
  // The controller's `force_scan` path always returns unchanged=false because it
  // deliberately bypasses the checksum fast path. That is an execution-mode flag,
  // not a change: three zero deltas and a clean working tree must still seal.
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath, fullScanClean: true })
  const outcome = assertEnvelope(
    await executeTool(toolFor(access.service, fakeTextAccess({ projectPath }))('handoff_export'), { dry_run: false }, fakeExec(root)),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.record.status, 'issued')
  assert.equal(await exists(join(root, outcome.data.record.archive.path)), true)
})

test('handoff_import dry run verifies the marker against git', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath })
  const texts = fakeTextAccess({ projectPath })
  const exportTool = toolFor(access.service, texts)('handoff_export')
  const exported = await executeTool(exportTool, { dry_run: false }, fakeExec(root))
  assert.equal(exported.ok, true)
  const archivePath = join(root, exported.data.record.archive.path)
  const importTool = toolFor(access.service, texts)('handoff_import')
  const outcome = assertEnvelope(await executeTool(importTool, { archive_path: archivePath }, fakeExec(root)))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.plan.marker.handoffId, exported.data.handoffId)
  assert.equal(outcome.data.plan.marker.baseCommit, (await git(root, ['rev-parse', 'HEAD'])).stdout.trim())
})

test('handoff_import refuses a renamed archive by default, accepts it only with the flag', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath, retrievedName: `${PROJECT}_1` })
  const texts = fakeTextAccess({ projectPath })
  const exported = await executeTool(toolFor(access.service, texts)('handoff_export'), { dry_run: false }, fakeExec(root))
  const archive = await renamedArchive(root, exported.data.record, `${PROJECT}_1`)

  const refused = assertEnvelope(
    await executeTool(toolFor(access.service, texts)('handoff_import'), { archive_path: archive }, fakeExec(root)),
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'handoff_project_name_changed')
  assert.equal(refused.error.details.markerProject, PROJECT)
  assert.equal(refused.error.details.archiveProject, `${PROJECT}_1`)

  const accepted = assertEnvelope(
    await executeTool(
      toolFor(access.service, texts)('handoff_import'),
      { archive_path: archive, accept_renamed_project: true },
      fakeExec(root),
    ),
  )
  assert.equal(accepted.ok, true)
  assert.equal(accepted.dryRun, true)
  assert.equal(accepted.data.plan.renamed, true)
  assert.equal(accepted.data.plan.nameAccepted, true)
  assert.equal(accepted.data.plan.archive.projectName, `${PROJECT}_1`)
})

test('handoff_import records the accepted rename and updates the index', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath, retrievedName: `${PROJECT}_1` })
  const texts = fakeTextAccess({ projectPath })
  const exported = await executeTool(toolFor(access.service, texts)('handoff_export'), { dry_run: false }, fakeExec(root))
  const archive = await renamedArchive(root, exported.data.record, `${PROJECT}_1`)

  const outcome = assertEnvelope(
    await executeTool(
      toolFor(access.service, texts)('handoff_import'),
      { archive_path: archive, accept_renamed_project: true, dry_run: false },
      fakeExec(root),
    ),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.record.nameChange.from, PROJECT)
  assert.equal(outcome.data.record.nameChange.to, `${PROJECT}_1`)
  assert.equal(await exists(join(root, 'tia', basename(root), `${PROJECT}_1`, `${PROJECT}_1.ap17`)), true)
  const index = JSON.parse(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'))
  assert.equal(index.project.name, `${PROJECT}_1`)
})

test('handoff_import refuses when HEAD advanced past the base', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath })
  const texts = fakeTextAccess({ projectPath })
  const exported = await executeTool(toolFor(access.service, texts)('handoff_export'), { dry_run: false }, fakeExec(root))
  const archivePath = join(root, exported.data.record.archive.path)
  await makeFile(join(root, 'source', DEVICE, 'blocks', 'OTHER.xml'), '<x/>')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'local change'])
  const outcome = assertEnvelope(
    await executeTool(toolFor(access.service, texts)('handoff_import'), { archive_path: archivePath }, fakeExec(root)),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'handoff_workspace_advanced')
})

test('handoff_import stops at awaiting_compile and keeps the old project backed up', async (t) => {
  const { root, projectPath } = await seededWorkspace(t)
  const access = fakeAccess({ projectPath })
  access.service.readPlcChecksum = async () => ({
    ok: false,
    summary: 'not compiled',
    error: { code: 'checksum_unavailable', message: 'compile first' },
  })
  const texts = fakeTextAccess({ projectPath })
  const exported = await executeTool(toolFor(access.service, texts)('handoff_export'), { dry_run: false }, fakeExec(root))
  const archivePath = join(root, exported.data.record.archive.path)
  const outcome = assertEnvelope(
    await executeTool(toolFor(access.service, texts)('handoff_import'), { archive_path: archivePath, dry_run: false }, fakeExec(root)),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.status, 'awaiting_compile')
  assert.equal(outcome.data.record.status, 'awaiting_compile')
  assert.equal(outcome.data.record.backup.present, true)
  assert.equal(await exists(join(root, outcome.data.record.backup.path, 'HandoffProject.ap17')), true)
  assert.equal(await exists(join(root, 'tia', basename(root), 'HandoffProject', 'HandoffProject.ap17')), true)
  const marker = await readFile(join(root, 'tia', basename(root), 'HandoffProject', 'UserFiles', '_dsh-handoff.json'), 'utf8')
  assert.match(marker, /"kind": "dsh-tia-handoff"/u)
})
