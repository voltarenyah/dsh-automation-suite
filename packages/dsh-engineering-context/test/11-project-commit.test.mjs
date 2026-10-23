/**
 * `project_commit` — the second half of the version workflow.
 *
 * `project_sync` writes the source tree and stops; this tool records it with a
 * message that says *why*. What these tests hold down:
 *
 * - the plan writes nothing and shows the exact message (trailers included);
 * - a real run commits exactly the device directory, never an unrelated dirty
 *   file elsewhere in the workspace;
 * - an empty message is refused, and so is a workspace with no evidence ledger;
 * - a message that already carries the trailer block (e.g. the one `project_sync`
 *   suggested) is not doubled.
 *
 * The workspace and git are real; only the `engineeringAccess` service is a fake,
 * because it is only asked which PLC the workspace belongs to.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

const COMMIT = 'project_commit'
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

function deviceDirectory(root) {
  return join(root, 'source', DEVICE)
}

function service() {
  return {
    async readTiaSession() {
      return {
        running: true,
        projectOpen: true,
        projectName: 'PEI_SinoARP',
        projectPath: 'C:\\TIA\\PEI_SinoARP.ap17',
        isModified: false,
        software: [{ device: DEVICE, software: SOFTWARE, blockCount: 1 }],
        reason: null,
      }
    },
    // `engineeringAccess` only hands over a service that carries all four
    // workflow methods; commit calls none of the other three.
    async openProject() {
      throw new Error('project_commit must never open a project')
    },
    async saveProjectAs() {
      throw new Error('project_commit must never save a project')
    },
    async rebuildSource() {
      throw new Error('project_commit must never rebuild the source tree')
    },
  }
}

function commitTool() {
  const { ctx } = createTestContext({ services: { engineeringAccess: service() } })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
  return findTool(definitions, COMMIT)
}

async function evidenceLedger(device, overrides = {}) {
  const document = {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: SOFTWARE,
    plcChecksum: 'BB',
    stateId: 'state-2',
    objects: {
      'block||FB1': {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'fingerprint-2' },
      },
    },
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
  await makeFile(join(device, '_evidence.json'), `${JSON.stringify(document, null, 2)}\n`)
}

/** A committed device directory with one changed block and a stale ledger file. */
async function dirtyWorkspace(t) {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>old</xml>')
  await evidenceLedger(device, { plcChecksum: 'AA', stateId: 'state-1' })
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  // The edit + the sync that promoted it.
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>new</xml>')
  await evidenceLedger(device)
  return { root, device }
}

test('the plan writes nothing and shows the exact message, trailers included', async (t) => {
  const { root } = await dirtyWorkspace(t)
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const outcome = assertEnvelope(
    await executeTool(commitTool(), { message: 'fix(cav-a): stop loading while the cooling belt is full' }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.wouldCommit, true)
  assert.deepEqual(outcome.data.paths, ['source/PLC1/_evidence.json', 'source/PLC1/blocks/010/FB1.xml'])
  assert.match(outcome.data.message, /^fix\(cav-a\): stop loading while the cooling belt is full$/mu)
  assert.match(outcome.data.message, /^Tia-Op: sync$/mu)
  assert.match(outcome.data.message, /^Tia-Checksum: BB$/mu)
  assert.match(outcome.data.message, /^Tia-State: state-2$/mu)
  assert.equal(outcome.data.evidence.objects, 1)

  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head, 'a plan must not create a commit')
  assert.match(await readFile(join(outcome.data.device.directory, 'blocks', '010', 'FB1.xml'), 'utf8'), /new/u)
})

test('a real run commits exactly the device directory with the caller message plus trailers', async (t) => {
  const { root } = await dirtyWorkspace(t)
  // An unrelated dirty file outside the device directory must not ride along.
  await makeFile(join(root, 'notes.txt'), 'scratch\n')

  const outcome = assertEnvelope(
    await executeTool(
      commitTool(),
      { dry_run: false, message: 'fix(cav-a): stop loading while the cooling belt is full' },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, false)
  assert.equal(outcome.data.committed, true)
  assert.match(outcome.data.hash, /^[0-9a-f]{40}$/u)

  const message = (await git(root, ['log', '-1', '--format=%B'])).stdout
  assert.match(message, /^fix\(cav-a\): stop loading while the cooling belt is full$/mu)
  assert.match(message, /^Tia-Op: sync$/mu)
  assert.match(message, /^Tia-Checksum: BB$/mu)
  assert.match(message, /^Tia-State: state-2$/mu)

  const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split(/\r?\n/u).sort()
  assert.deepEqual(files, ['source/PLC1/_evidence.json', 'source/PLC1/blocks/010/FB1.xml'])
  assert.match((await git(root, ['status', '--porcelain'])).stdout, /\?\? notes\.txt/u, 'the unrelated file stays uncommitted')
  assert.equal((await git(root, ['status', '--porcelain', '--', 'source/PLC1'])).stdout.trim(), '', 'the device directory is clean')
})

test('a message that already carries the trailer block is not doubled', async (t) => {
  const { root } = await dirtyWorkspace(t)
  const suggested = 'sync: PLC1 — 1 changed, 0 added, 0 removed\n\nTia-Op: sync\nTia-Checksum: BB\nTia-State: state-2\nTia-Manifest: updated'

  const outcome = assertEnvelope(await executeTool(commitTool(), { dry_run: false, message: suggested }, fakeExec(root)))

  assert.equal(outcome.data.committed, true)
  const message = (await git(root, ['log', '-1', '--format=%B'])).stdout
  assert.equal(message.split('Tia-Op:').length - 1, 1, 'exactly one trailer block')
})

test('an empty message is refused and nothing is committed', async (t) => {
  const { root } = await dirtyWorkspace(t)
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const outcome = assertEnvelope(await executeTool(commitTool(), { message: '   ' }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_commit_message')
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head)
})

test('a workspace with no evidence ledger refuses to commit an unknown provenance', async (t) => {
  const root = await gitWorkspace(t)
  const device = deviceDirectory(root)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>new</xml>')
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>changed</xml>')

  const outcome = assertEnvelope(await executeTool(commitTool(), { message: 'chore: something' }, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'not_synced')
  assert.match(outcome.error.message, /project_sync/u)
})

test('a clean device directory reports nothing to commit instead of failing', async (t) => {
  const { root } = await dirtyWorkspace(t)
  await executeTool(commitTool(), { dry_run: false, message: 'fix(cav-a): the change' }, fakeExec(root))

  const plan = assertEnvelope(await executeTool(commitTool(), { message: 'fix(cav-a): the change' }, fakeExec(root)))
  assert.equal(plan.ok, true)
  assert.equal(plan.data.wouldCommit, false)
  assert.deepEqual(plan.data.paths, [])

  const real = assertEnvelope(
    await executeTool(commitTool(), { dry_run: false, message: 'fix(cav-a): the change' }, fakeExec(root)),
  )
  assert.equal(real.ok, true)
  assert.equal(real.data.committed, false)
  assert.equal(real.data.hash, null)
})
