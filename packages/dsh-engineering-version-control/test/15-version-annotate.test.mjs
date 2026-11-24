/**
 * Annotating a version: reason, problem, acceptance, references.
 *
 * The mechanical facts come from git; the engineering background is what the
 * agent adds afterwards. Annotating updates the event row, the timeline
 * projection and the graph together, and the problem view reads them back.
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
  loadVersionToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { versionTools } = await loadVersionToolsModule()
const { resolveConfig } = await loadConfigModule()
const execFileAsync = promisify(execFile)

const DEVICE = 'PLC1'
const BLOCK = 'block||FB1'

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
}

function evidence(fingerprint = { Code: 'a1' }) {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: 'SW1',
    plcChecksum: 'C0',
    stateId: 'state-1',
    objects: {
      [BLOCK]: { category: 'block', name: 'FB1', group: '010', path: 'blocks/010/FB1.xml', fingerprint },
    },
    unexportable: [],
    tombstones: [],
  }
}

async function workspace(t) {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Annotate Test'])
  await makeFile(join(root, 'source', DEVICE, '_evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`)
  await makeFile(join(root, 'source', DEVICE, 'blocks/010/FB1.xml'), '<x>v1</x>')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'chore: baseline'])

  await makeFile(join(root, 'source', DEVICE, '_evidence.json'), `${JSON.stringify(evidence({ Code: 'a2' }), null, 2)}\n`)
  await makeFile(join(root, 'source', DEVICE, 'blocks/010/FB1.xml'), '<x>v2</x>')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'feat: change FB1'])
  const { stdout } = await git(root, ['rev-parse', 'HEAD'])
  return { root, commit: stdout.trim() }
}

function toolsFor() {
  const { ctx } = createTestContext()
  const config = resolveConfig()
  return { definitions: versionTools({ ctx, config, log: ctx.logger }), config }
}

async function call(definitions, name, args, root) {
  const definition = findTool(definitions, name)
  const value = await executeTool(definition, args, fakeExec(root))
  assertEnvelope(value)
  return value
}

test('annotate updates the timeline, the problem view and the acceptance', async (t) => {
  const { root, commit } = await workspace(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const annotated = await call(
    definitions,
    'project_version_annotate',
    {
      commit,
      reason: 'the cooling table must not ask for a full cycle while occupied',
      problem: 'cooling-table-blocked',
      acceptance: 'accepted',
      references: ['req-42'],
    },
    root,
  )
  assert.equal(annotated.ok, true)
  assert.deepEqual(annotated.data.applied.sort(), ['acceptance=accepted', 'problem', 'reason', '1 reference(s)'].sort())

  const history = await call(definitions, 'project_history', { block: BLOCK }, root)
  assert.equal(history.data.entries.length, 1)
  assert.equal(history.data.entries[0].problem, 'cooling-table-blocked')
  assert.match(history.data.entries[0].reason, /cooling table/)

  const problem = await call(definitions, 'project_problem', { ref: 'cooling-table-blocked' }, root)
  assert.equal(problem.ok, true)
  assert.equal(problem.data.changes.length, 1)
  assert.equal(problem.data.changes[0].commit, commit)

  const detail = await call(definitions, 'project_history', { commit }, root)
  assert.equal(detail.data.version.acceptance, 'accepted')
})

test('the query tool runs reads and refuses writes', async (t) => {
  const { root } = await workspace(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_version_reindex', {}, root)

  const read = await call(definitions, 'project_version_query', { sql: 'SELECT COUNT(*) AS n FROM versions' }, root)
  assert.equal(read.ok, true)
  assert.equal(read.data.rows[0].n, 2)

  for (const sql of ['DELETE FROM versions', 'UPDATE versions SET subject = "x"', 'DROP TABLE versions']) {
    const refused = await call(definitions, 'project_version_query', { sql }, root)
    assert.equal(refused.ok, true)
    assert.equal(refused.data.refused, true)
  }
})
