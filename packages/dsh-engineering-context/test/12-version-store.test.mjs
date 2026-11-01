/**
 * The version store: replay, timeline, checksum lookup, verification.
 *
 * A real temporary git repository is used, with a hand-written `_evidence.json`
 * per commit. What these tests hold down:
 *
 * - replaying three commits produces three versions and two change events
 *   (the baseline is not a change);
 * - a block's timeline is ordered, with fingerprint before/after and faces;
 * - one checksum can belong to several versions (repeated checksum);
 * - `project_version_verify` agrees, and a gap is detected;
 * - deleting the store and replaying reproduces the same rows.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
  loadVersionToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { versionTools } = await loadVersionToolsModule()
const { resolveConfig } = await loadConfigModule()
const execFileAsync = promisify(execFile)

const DEVICE = 'PLC1'
const BLOCK_A = 'block||FB1'
const BLOCK_B = 'block||FB2'

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
}

async function gitWorkspace(t) {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Version Store Test'])
  return root
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: 'SW1',
    plcChecksum: 'C0',
    stateId: 'state-1',
    objects: {
      [BLOCK_A]: {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a1', Interface: 'i1', Comments: 'c1' },
      },
      [BLOCK_B]: {
        category: 'block',
        name: 'FB2',
        group: '010',
        path: 'blocks/010/FB2.xml',
        fingerprint: { Code: 'b1' },
      },
    },
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
}

async function writeState(root, document, files = {}) {
  await makeFile(join(root, 'source', DEVICE, '_evidence.json'), `${JSON.stringify(document, null, 2)}\n`)
  for (const [name, content] of Object.entries(files)) {
    await makeFile(join(root, 'source', DEVICE, name), content)
  }
}

async function commit(root, message) {
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', message])
  const { stdout } = await git(root, ['rev-parse', 'HEAD'])
  return stdout.trim()
}

/** Three commits: baseline, a Code change on FB1, then a Comments change on FB1. */
async function history(t) {
  const root = await gitWorkspace(t)
  await writeState(root, evidence(), {
    'blocks/010/FB1.xml': '<x>v1</x>',
    'blocks/010/FB2.xml': '<x>v1</x>',
  })
  const base = await commit(root, 'chore: baseline')

  const second = evidence({
    plcChecksum: '71',
    stateId: 'state-2',
    objects: {
      [BLOCK_A]: {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a2', Interface: 'i1', Comments: 'c1' },
      },
      [BLOCK_B]: {
        category: 'block',
        name: 'FB2',
        group: '010',
        path: 'blocks/010/FB2.xml',
        fingerprint: { Code: 'b1' },
      },
    },
  })
  await writeState(root, second, { 'blocks/010/FB1.xml': '<x>v2</x>' })
  const secondSha = await commit(root, 'feat: change FB1 code\n\nbecause the interlock was missing')

  const third = evidence({
    plcChecksum: '71',
    stateId: 'state-3',
    objects: {
      [BLOCK_A]: {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a2', Interface: 'i1', Comments: 'c3' },
      },
      [BLOCK_B]: {
        category: 'block',
        name: 'FB2',
        group: '010',
        path: 'blocks/010/FB2.xml',
        fingerprint: { Code: 'b1' },
      },
    },
  })
  await writeState(root, third, { 'blocks/010/FB1.xml': '<x>v3</x>' })
  const thirdSha = await commit(root, 'docs: comment FB1')

  return { root, base, secondSha, thirdSha }
}

function toolsFor() {
  const { ctx, logs } = createTestContext()
  const config = resolveConfig()
  const definitions = versionTools({ ctx, config, log: ctx.logger })
  return { definitions, logs, config }
}

async function call(definitions, name, args, root) {
  const definition = findTool(definitions, name)
  const value = await executeTool(definition, args, fakeExec(root))
  assertEnvelope(value)
  return value
}

test('replay: three commits become three versions and two change events', async (t) => {
  const { root } = await history(t)
  const { definitions } = toolsFor()

  const reindex = await call(definitions, 'project_version_reindex', {}, root)
  assert.equal(reindex.ok, true)
  assert.equal(reindex.data.versions, 3)
  assert.equal(reindex.data.events, 2)
  assert.equal(reindex.data.baseline, 2)
  assert.deepEqual(reindex.data.skipped, [])

  const historyCall = await call(definitions, 'project_history', { block: BLOCK_A }, root)
  assert.equal(historyCall.ok, true)
  const entries = historyCall.data.entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0].seq, 1)
  assert.equal(entries[1].seq, 2)
  assert.deepEqual(entries[0].faces.sort(), ['Code'])
  assert.deepEqual(entries[1].faces.sort(), ['Comments'])
  assert.equal(entries[0].fingerprintBefore.Code, 'a1')
  assert.equal(entries[0].fingerprintAfter.Code, 'a2')
  assert.equal(entries[0].reason, 'because the interlock was missing')

  // A bare block name (no `|`) is accepted too: it matches the key's last segment.
  const byName = await call(definitions, 'project_history', { block: 'FB1' }, root)
  assert.equal(byName.data.entries.length, 2)
})

test('checksum lookup returns every version carrying it, repeats included', async (t) => {
  const { root } = await history(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const one = await call(definitions, 'project_history', { checksum: '71' }, root)
  assert.equal(one.data.versions.length, 2)

  const base = await call(definitions, 'project_history', { checksum: 'C0' }, root)
  assert.equal(base.data.versions.length, 1)
})

test('commit details list the changed objects and the checksum transition', async (t) => {
  const { root, secondSha } = await history(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const detail = await call(definitions, 'project_history', { commit: secondSha }, root)
  assert.equal(detail.ok, true)
  assert.equal(detail.data.version.checksumPrev, 'C0')
  assert.equal(detail.data.version.checksum, '71')
  assert.equal(detail.data.changes.length, 1)
  assert.equal(detail.data.changes[0].key, BLOCK_A)
  assert.deepEqual(detail.data.changes[0].faces.sort(), ['Code'])
})

test('verify accepts a consistent store and detects a gap', async (t) => {
  const { root } = await history(t)
  const { definitions, config } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const ok = await call(definitions, 'project_version_verify', {}, root)
  assert.equal(ok.ok, true)
  assert.equal(ok.data.ok, true)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root, config.stateDirName, 'versions.db'))
  try {
    db.exec("UPDATE block_timeline SET seq = 5 WHERE seq = 1")
  } finally {
    db.close()
  }
  const broken = await call(definitions, 'project_version_verify', {}, root)
  assert.equal(broken.ok, true)
  assert.equal(broken.data.ok, false)
  assert.ok(broken.data.problems.some((problem) => problem.includes('gap') || problem.includes('bad start')))
})

test('deleting the store and replaying reproduces the same rows', async (t) => {
  const { root } = await history(t)
  const { definitions, config } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const dbPath = join(root, config.stateDirName, 'versions.db')
  assert.equal(existsSync(dbPath), true)
  await rm(dbPath, { force: true })
  for (const suffix of ['-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true })
  assert.equal(existsSync(dbPath), false)

  const again = await call(definitions, 'project_version_reindex', {}, root)
  assert.equal(again.data.versions, 3)
  assert.equal(again.data.events, 2)

  const historyCall = await call(definitions, 'project_history', { block: BLOCK_A }, root)
  assert.equal(historyCall.data.entries.length, 2)
  assert.equal(historyCall.data.entries[1].fingerprintAfter.Comments, 'c3')
})
