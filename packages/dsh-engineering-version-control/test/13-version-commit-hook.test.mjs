/**
 * `project_commit` records the commit in the version store.
 *
 * The commit itself must not change: same paths, same message, same trailers.
 * The store is written **after** the commit exists, and a store failure must be
 * a warning, never a failed commit.
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

const DEVICE = 'PLC1'
const SOFTWARE = 'SW1'

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
}

function service() {
  return {
    async readTiaSession() {
      return {
        running: true,
        projectOpen: true,
        projectName: 'P',
        projectPath: 'C:\\TIA\\P.ap17',
        isModified: false,
        software: [{ device: DEVICE, software: SOFTWARE, blockCount: 1 }],
        reason: null,
      }
    },
    async openProject() {
      throw new Error('must not open')
    },
    async saveProjectAs() {
      throw new Error('must not save')
    },
    async rebuildSource() {
      throw new Error('must not rebuild')
    },
  }
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: SOFTWARE,
    plcChecksum: 'C0',
    stateId: 'state-1',
    objects: {
      'block||FB1': {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a1' },
      },
    },
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
}

async function writeState(root, document, xml) {
  await makeFile(join(root, 'source', DEVICE, '_evidence.json'), `${JSON.stringify(document, null, 2)}\n`)
  await makeFile(join(root, 'source', DEVICE, 'blocks/010/FB1.xml'), xml)
}

test('a commit is recorded in the version store after it is created', async (t) => {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Version Slot Test'])

  await writeState(root, evidence(), '<x>v1</x>')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'chore: baseline'])

  const changed = evidence({
    plcChecksum: '71',
    stateId: 'state-2',
    objects: {
      'block||FB1': {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a2' },
      },
    },
  })
  await writeState(root, changed, '<x>v2</x>')

  const { ctx } = createTestContext({ services: { engineeringAccess: service() } })
  const config = resolveConfig()
  const definitions = toolDefinitions({ ctx, config, log: ctx.logger })
  const commit = findTool(definitions, 'project_commit')

  const result = await executeTool(
    commit,
    { message: 'feat: change FB1 code\n\nbecause of the interlock', dry_run: false },
    fakeExec(root),
  )
  assertEnvelope(result)
  assert.equal(result.ok, true)
  assert.equal(result.data.committed, true)
  assert.ok(result.data.hash)
  assert.notEqual(result.data.versionStore, null)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root, config.stateDirName, 'versions.db'))
  try {
    const versions = db.prepare('SELECT COUNT(*) AS n FROM versions').get()
    assert.equal(versions.n, 2)
    const events = db.prepare('SELECT commit_sha, object_key, change FROM change_events').all()
    assert.equal(events.length, 1)
    assert.equal(events[0].object_key, 'block||FB1')
    assert.equal(events[0].change, 'modified')
    const timeline = db.prepare('SELECT block_key, seq FROM block_timeline').all()
    assert.equal(timeline.length, 1)
    assert.equal(timeline[0].seq, 1)
  } finally {
    db.close()
  }
})
