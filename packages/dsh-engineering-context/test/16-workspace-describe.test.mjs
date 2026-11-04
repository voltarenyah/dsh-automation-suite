/**
 * `workspace_describe` — the read-only report of ANOTHER workspace on disk.
 *
 * The point of these tests is the contract that makes a reference workspace
 * usable from a session that is scoped to a different directory: one call must
 * answer "what project is this, which devices, how much XML, which knowledge
 * databases and how fresh, and what does git say" without opening TIA.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { toolDefinitions } = await loadToolsModule()
const { resolveConfig } = await loadConfigModule()
const execFileAsync = promisify(execFile)

const DESCRIBE = 'workspace_describe'
const DEVICE = 'PEI_1'

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

function service() {
  return {
    async readTiaSession() {
      throw new Error('workspace_describe must never read the TIA session')
    },
    async openProject() {
      throw new Error('workspace_describe must never open a project')
    },
    async saveProjectAs() {
      throw new Error('workspace_describe must never save a project')
    },
    async rebuildSource() {
      throw new Error('workspace_describe must never rebuild a source tree')
    },
  }
}

function describeTool() {
  const { ctx } = createTestContext({ services: { engineeringAccess: service() } })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
  return findTool(definitions, DESCRIBE)
}

/** A workspace shaped like a real managed project. */
async function managedWorkspace(t) {
  const root = await gitWorkspace(t)
  const device = join(root, 'source', DEVICE)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml/>')
  await makeFile(join(device, 'types', 'UDT1.xml'), '<xml/>')
  await makeFile(join(device, 'tag_tables', 'T1.xml'), '<xml/>')
  await makeFile(
    join(device, '_manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      device: DEVICE,
      software: DEVICE,
      failureCount: 1,
      blocks: [
        { name: 'FB1', category: 'blocks', file: 'blocks/010/FB1.xml', verified: true },
        { name: 'UDT1', category: 'types', file: 'types/UDT1.xml', verified: true },
        { name: 'T1', category: 'tag_tables', file: 'tag_tables/T1.xml', verified: true },
      ],
      failures: [{ name: 'FOB', reason: 'not permitted' }],
    }),
  )
  await makeFile(
    join(device, '_evidence.json'),
    JSON.stringify({
      schemaVersion: 1,
      device: DEVICE,
      software: DEVICE,
      plcChecksum: 'AA BB',
      stateId: 'sha256:abc',
      objects: { a: {}, b: {}, c: {} },
      unexportable: [],
      tombstones: [],
    }),
  )
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: {
        name: 'P1',
        path: 'C:\\Projects\\P1\\P1.ap17',
        savedAs: join(root, 'tia', 'P1', 'P1.ap17'),
        archive: null,
      },
      exportedAt: '2026-11-04T04:01:19.966Z',
      devices: [{ device: DEVICE, software: DEVICE, directory: device }],
    }),
  )
  await makeFile(join(root, 'knowledge', DEVICE, `${DEVICE}_knowledge.db`), 'sqlite-bytes')
  await makeFile(
    join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`),
    JSON.stringify({ plcChecksum: 'AA BB', builtAt: '2026-11-04T04:01:20.000Z' }),
  )
  await makeFile(join(root, 'hardware', 'globalHardware.aml'), '<AML/>')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'baseline'])
  return { root, device }
}

test('describes another workspace from a session scoped elsewhere, without TIA', async (t) => {
  const { root } = await managedWorkspace(t)
  const elsewhere = await tempWorkspace(t)

  const outcome = assertEnvelope(await executeTool(describeTool(), { workspace_path: root }, fakeExec(elsewhere)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.scope.workspace.path, root, 'the scope is the described workspace, not the session one')
  assert.equal(outcome.data.index.present, true)
  assert.equal(outcome.data.index.role, 'primary')
  assert.equal(outcome.data.index.project.name, 'P1')
  assert.equal(outcome.data.index.exportedAt, '2026-11-04T04:01:19.966Z')

  assert.equal(outcome.data.source.exists, true)
  assert.equal(outcome.data.source.devices.length, 1)
  const device = outcome.data.source.devices[0]
  assert.equal(device.device, DEVICE)
  assert.deepEqual(device.xml, { blocks: 1, types: 1, tagTables: 1, total: 3 })
  assert.equal(device.manifest.rows, 3)
  assert.equal(device.manifest.failures, 1)
  assert.equal(device.evidence.objects, 3)
  assert.equal(device.evidence.stateId, 'sha256:abc')
  assert.equal(device.knowledge.present, true)
  assert.equal(device.knowledge.freshness, 'fresh')
  assert.ok(device.knowledge.bytes > 0)

  assert.equal(outcome.data.hardware.exists, true)
  assert.equal(outcome.data.git.repository, true)
  assert.match(outcome.data.git.head.short, /^[0-9a-f]{7,}$/u)
  assert.equal(outcome.data.git.dirtyCount, 0)

  const details = outcome.details.join('\n')
  assert.match(details, /Project: P1 \(primary\)/u)
  assert.match(details, /Source: source\/ — 1 device\(s\), 3 XML \(1 blocks, 1 types, 1 tag tables\)/u)
  assert.match(details, /knowledge: knowledge\/PEI_1\/PEI_1_knowledge\.db/u)
  assert.match(details, /Git: [0-9a-f]+ "baseline"/u)
  assert.match(outcome.summary, /^P1: 1 device \(PEI_1\), 3 XML, graph fresh/u)
})

test('a stale graph is reported as stale, not as fresh', async (t) => {
  const { root } = await managedWorkspace(t)
  await makeFile(
    join(root, '.dsh', 'local', 'graph', `${DEVICE}.json`),
    JSON.stringify({ plcChecksum: 'CC DD', builtAt: '2026-11-04T04:01:20.000Z' }),
  )

  const outcome = assertEnvelope(await executeTool(describeTool(), { workspace_path: root }, fakeExec(root)))

  assert.equal(outcome.data.source.devices[0].knowledge.freshness, 'stale')
  assert.match(outcome.details.join('\n'), /graph STALE|, stale/u)
})

test('a workspace with no source tree is described, with a warning instead of a failure', async (t) => {
  const root = await gitWorkspace(t)

  const outcome = assertEnvelope(await executeTool(describeTool(), { workspace_path: root }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.index.present, false)
  assert.equal(outcome.data.source.exists, false)
  assert.deepEqual(outcome.data.source.devices, [])
  assert.match(outcome.summary, /^\(unnamed project\): 0 devices/u)
  assert.ok(outcome.warnings.some((warning) => /no source tree/u.test(warning)))
})

test('a missing path is a coded failure', async (t) => {
  const root = await tempWorkspace(t)
  const missing = join(root, 'does-not-exist')

  const outcome = assertEnvelope(await executeTool(describeTool(), { workspace_path: missing }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'workspace_not_found')
})

test('omitting workspace_path describes the session workspace', async (t) => {
  const { root } = await managedWorkspace(t)

  const outcome = assertEnvelope(await executeTool(describeTool(), {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.scope.workspace.path, root)
  assert.equal(outcome.data.index.project.name, 'P1')
})

test('a broken index is a warning beside the on-disk facts, not a failed report', async (t) => {
  const { root } = await managedWorkspace(t)
  await writeFile(join(root, 'source', '_dsh-engineering-context.json'), '{ not json', 'utf8')
  await mkdir(join(root, 'source', DEVICE), { recursive: true })

  const outcome = assertEnvelope(await executeTool(describeTool(), { workspace_path: root }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.index.present, false)
  assert.ok(outcome.warnings.some((warning) => /index/u.test(warning)))
  assert.equal(outcome.data.source.devices.length, 1)
})
