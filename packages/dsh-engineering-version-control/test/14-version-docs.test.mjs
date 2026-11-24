/**
 * Document indexing: front matter links, heading spans, full-text search.
 *
 * The document stays on disk; the store keeps its hash, spans and searchable
 * text, and the DOCUMENTS edges that attach it to the block(s) it declares.
 * A wrong edge is worse than a missing one, so only front matter creates links.
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

function evidence() {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: 'SW1',
    plcChecksum: 'C0',
    stateId: 'state-1',
    objects: {
      [BLOCK]: {
        category: 'block',
        name: 'FB1',
        group: '010',
        path: 'blocks/010/FB1.xml',
        fingerprint: { Code: 'a1' },
      },
    },
    unexportable: [],
    tombstones: [],
  }
}

const DOC = `---
kind: design
affects:
  - block||FB1
problems: [cooling-table-blocked]
---
# 冷却台互锁设计

## 背景

当冷却台被占用时，不应发起整周期请求。

## 方案

在 N4 增加 CoolingTableBlocked。
`

async function workspace(t) {
  const root = await tempWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Doc Index Test'])
  await makeFile(join(root, 'source', DEVICE, '_evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`)
  await makeFile(join(root, 'source', DEVICE, 'blocks/010/FB1.xml'), '<x>v1</x>')
  await makeFile(join(root, '.dsh/docs/cooling.md'), DOC)
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'chore: baseline'])
  return root
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

test('indexing links declared blocks and problems, and extracts spans', async (t) => {
  const root = await workspace(t)
  const { definitions } = toolsFor()

  const index = await call(definitions, 'project_doc_index', {}, root)
  assert.equal(index.ok, true)
  assert.equal(index.data.scanned, 1)
  assert.equal(index.data.indexed, 1)
  assert.equal(index.data.linked, 2)
  assert.equal(index.data.fts, true)

  const history = await call(definitions, 'project_history', { block: BLOCK }, root)
  assert.equal(history.data.documents.length, 1)
  assert.match(history.data.documents[0].path, /cooling\.md$/)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root, '.dsh', 'versions.db'))
  try {
    const spans = db.prepare('SELECT heading FROM doc_spans ORDER BY start_line').all()
    assert.deepEqual(spans.map((row) => row.heading), ['冷却台互锁设计', '背景', '方案'])
    const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get()
    assert.equal(docs.n, 1)
  } finally {
    db.close()
  }
})

test('full-text search finds Chinese text, with a LIKE fallback for short terms', async (t) => {
  const root = await workspace(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_doc_index', {}, root)

  const long = await call(definitions, 'project_doc_search', { query: '冷却台' }, root)
  assert.equal(long.ok, true)
  assert.equal(long.data.hits.length, 1)

  const short = await call(definitions, 'project_doc_search', { query: '冷却' }, root)
  assert.equal(short.ok, true)
  assert.equal(short.data.hits.length, 1)
})

test('a re-indexed document keeps its old version and adds the new one', async (t) => {
  const root = await workspace(t)
  const { definitions } = toolsFor()
  await call(definitions, 'project_doc_index', {}, root)

  const updated = `${DOC}\n追加：验收通过。\n`
  await makeFile(join(root, '.dsh/docs/cooling.md'), updated)
  const again = await call(definitions, 'project_doc_index', {}, root)
  assert.equal(again.data.indexed, 1)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root, '.dsh', 'versions.db'))
  try {
    const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get()
    assert.equal(docs.n, 2)
  } finally {
    db.close()
  }
})
