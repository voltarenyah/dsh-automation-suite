/**
 * `project_commit` without TIA — the R1 contract.
 *
 * Recording history is a git + filesystem operation. These tests hold down that
 * it stays one:
 *
 * - the device is resolved from the workspace (the creation index first, then
 *   `source/<device>/_evidence.json`), so **no** `engineeringAccess` service is
 *   needed at all;
 * - when the service *is* present, a closed TIA, a different project or several
 *   PLCs produce a **warning**, never a refusal — the commit still happens;
 * - the multi-device case is resolved by naming the device, not refused;
 * - a directory hint that points outside `source/` is ignored with a warning.
 *
 * The workspace and git are real; the service is a fake, and most tests do not
 * provide one.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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

/** A session report shaped like the interface plugin's. */
function session(overrides = {}) {
  return {
    running: true,
    projectOpen: true,
    projectName: 'PEI_SinoARP',
    projectPath: 'C:\\TIA\\PEI_SinoARP.ap17',
    isModified: false,
    software: [{ device: DEVICE, software: SOFTWARE, blockCount: 1 }],
    reason: null,
    ...overrides,
  }
}

/**
 * The service has to carry all four workflow methods: `engineeringAccess()`
 * hands a service over only when it looks like the interface plugin's, and the
 * cross-check is the only one commit calls.
 */
function service(report) {
  return {
    async readTiaSession() {
      return report
    },
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

/**
 * @param {object | null} report - the fake session, or null for "service absent".
 */
function commitTool(report = null) {
  const services = report === null ? {} : { engineeringAccess: service(report) }
  const { ctx } = createTestContext({ services })
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

/** A repository whose device directory has an uncommitted, synced change. */
async function dirtyWorkspace(t) {
  const root = await gitWorkspace(t)
  const device = join(root, 'source', DEVICE)
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>old</xml>')
  await evidenceLedger(device, { plcChecksum: 'AA', stateId: 'state-1' })
  await git(root, ['add', '--', 'source/PLC1'])
  await git(root, ['commit', '-q', '-m', 'import'])
  await makeFile(join(device, 'blocks', '010', 'FB1.xml'), '<xml>new</xml>')
  await evidenceLedger(device)
  return { root, device }
}

test('a composition with no engineeringAccess service can still plan a commit', async (t) => {
  const { root } = await dirtyWorkspace(t)

  const outcome = assertEnvelope(
    await executeTool(commitTool(null), { message: 'fix(cav-a): the change' }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true, 'no TIA service must not block recording history')
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.deviceOrigin, 'evidence', 'resolved by scanning source/')
  assert.equal(outcome.data.device.device, DEVICE)
  assert.equal(outcome.data.device.software, SOFTWARE, 'the ledger fills the software name')
  assert.deepEqual(outcome.data.paths, ['source/PLC1/_evidence.json', 'source/PLC1/blocks/010/FB1.xml'])
  assert.match(outcome.data.message, /^Tia-Checksum: BB$/mu)
  assert.deepEqual(outcome.warnings, [], 'a missing service is normal, not a warning')
})

test('a real commit without TIA writes the trailers and moves HEAD', async (t) => {
  const { root } = await dirtyWorkspace(t)
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()

  const outcome = assertEnvelope(
    await executeTool(commitTool(null), { dry_run: false, message: 'fix(cav-a): the change' }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.committed, true)
  assert.notEqual((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), head)
  const message = (await git(root, ['log', '-1', '--format=%B'])).stdout
  assert.match(message, /^Tia-Op: sync$/mu)
  assert.match(message, /^Tia-State: state-2$/mu)
})

test('the creation index is preferred and reports software without reading the ledger', async (t) => {
  const { root, device } = await dirtyWorkspace(t)
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    `${JSON.stringify(
      { schemaVersion: 1, devices: [{ device: DEVICE, software: SOFTWARE, directory: device }] },
      null,
      2,
    )}\n`,
  )

  const outcome = assertEnvelope(
    await executeTool(commitTool(null), { message: 'fix(cav-a): the change' }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.deviceOrigin, 'index')
  assert.equal(outcome.data.device.software, SOFTWARE)
  assert.equal(outcome.data.device.directory.toLowerCase(), device.toLowerCase())
  assert.deepEqual(outcome.warnings, [], 'a usable hint is not a warning')
})

test('an unusable index hint is ignored with a warning, not followed', async (t) => {
  const { root, device } = await dirtyWorkspace(t)
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    `${JSON.stringify(
      // The real index records an absolute path; a copied workspace or an older
      // index can carry one that no longer names a device directory.
      { schemaVersion: 1, devices: [{ device: DEVICE, software: SOFTWARE, directory: join(root, 'source', 'gone') }] },
      null,
      2,
    )}\n`,
  )

  const outcome = assertEnvelope(
    await executeTool(commitTool(null), { message: 'fix(cav-a): the change' }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true, 'a stale hint must not break the commit')
  assert.equal(outcome.data.device.directory.toLowerCase(), device.toLowerCase(), 'fell back to source/PLC1')
  assert.equal(outcome.warnings.length, 1)
  assert.match(outcome.warnings[0], /not a usable device directory/u)
})

test('TIA not running is a warning that still commits', async (t) => {
  const { root } = await dirtyWorkspace(t)

  const outcome = assertEnvelope(
    await executeTool(
      commitTool(session({ running: false, projectOpen: false, software: [], reason: 'not started' })),
      { dry_run: false, message: 'fix(cav-a): the change' },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.committed, true)
  assert.equal(outcome.warnings.length, 1)
  assert.match(outcome.warnings[0], /not running/u)
})

test('a different project being open is reported by name, and still commits', async (t) => {
  const { root } = await dirtyWorkspace(t)

  const outcome = assertEnvelope(
    await executeTool(
      commitTool(session({ software: [{ device: 'OTHER', software: 'SW9', blockCount: 1 }] })),
      { dry_run: false, message: 'fix(cav-a): the change' },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.committed, true)
  assert.equal(outcome.warnings.length, 1)
  assert.match(outcome.warnings[0], /"OTHER"/u)
  assert.match(outcome.warnings[0], /"PLC1"/u)
})

test('several PLCs open is a warning; the workspace device is what gets recorded', async (t) => {
  const { root } = await dirtyWorkspace(t)

  const outcome = assertEnvelope(
    await executeTool(
      commitTool(
        session({
          software: [
            { device: 'A', software: 'SWA', blockCount: 1 },
            { device: 'B', software: 'SWB', blockCount: 1 },
          ],
        }),
      ),
      { message: 'fix(cav-a): the change' },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.device.device, DEVICE)
  assert.equal(outcome.warnings.length, 1)
  assert.match(outcome.warnings[0], /2 PLCs open/u)
})

test('two device trees need a name, and the name resolves it', async (t) => {
  const { root } = await dirtyWorkspace(t)
  const second = join(root, 'source', 'PLC2')
  await makeFile(join(second, 'blocks', '010', 'FB1.xml'), '<xml>second</xml>')
  await evidenceLedger(second, { device: 'PLC2', software: 'SW2', plcChecksum: 'AA', stateId: 'state-1' })
  await git(root, ['add', '--', 'source/PLC2'])
  await git(root, ['commit', '-q', '-m', 'add second device'])
  await makeFile(join(second, 'blocks', '010', 'FB1.xml'), '<xml>second changed</xml>')
  await evidenceLedger(second, { device: 'PLC2', software: 'SW2' })

  const unnamed = assertEnvelope(
    await executeTool(commitTool(null), { message: 'fix: second' }, fakeExec(root)),
  )
  assert.equal(unnamed.ok, false)
  assert.equal(unnamed.error.code, 'multiple_plc_unsupported')
  assert.match(unnamed.error.message, /PLC1/u)
  assert.match(unnamed.error.message, /PLC2/u)

  const named = assertEnvelope(
    await executeTool(commitTool(null), { dry_run: false, message: 'fix: second', device: 'plc2' }, fakeExec(root)),
  )
  assert.equal(named.ok, true)
  assert.equal(named.data.device.device, 'PLC2')
  const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split(/\r?\n/u).sort()
  assert.deepEqual(files, ['source/PLC2/_evidence.json', 'source/PLC2/blocks/010/FB1.xml'])
})
