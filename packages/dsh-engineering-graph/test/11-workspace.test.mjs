/**
 * Workspace discovery and the optional `db_path`.
 *
 * Two things are asserted here, because they are the whole point of
 * `knowledge_workspace` (docs/decisions.md D24):
 *
 *   1. **The report is honest about what is on disk.** A workspace with no
 *      project, a project with no database, a database the index does not know
 *      about, a corrupt index, SQLite's side files: each has one expected reading,
 *      and none of them is an exception.
 *   2. **`knowledge_query` never guesses between devices.** Omitted `db_path`
 *      resolves when exactly one device has a database, and is refused with the
 *      candidates named when none or several do — the engine must not even be
 *      asked in the refusal cases.
 *
 * Discovery never touches the engine, so these tests need no C# half; the two
 * query tests drive the tool bodies against a recording stub.
 *
 * Test data lives in `os.tmpdir()` and is removed afterwards.
 *
 * @module dsh-engineering-graph/test/workspace
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createTestContext, executeTool, loadToolsModule, loadWorkspaceModule } from './helpers/harness.mjs'

const workspace = await loadWorkspaceModule()

/** Roots created by this file, removed in one sweep at the end. */
const created = []
after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

/** A fresh temporary workspace root. */
function makeRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `graph-workspace-${label}-`))
  created.push(root)
  return root
}

/** Write the context plugin's index, in the shape `create_engineering_project` writes. */
function writeIndex(root, project, devices) {
  mkdirSync(join(root, 'source'), { recursive: true })
  writeFileSync(
    join(root, 'source', '_dsh-engineering-context.json'),
    `${JSON.stringify({ schemaVersion: 1, project, exportedAt: '2026-10-19T09:00:00.000Z', devices }, undefined, 2)}\n`,
    'utf8',
  )
}

/** Create `knowledge/<device>/<file>` with `bytes` of content. */
function writeDatabase(root, device, file, content = 'x'.repeat(2048)) {
  const folder = join(root, 'knowledge', device)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, file)
  writeFileSync(path, content)
  return path
}

/** The index entry for one device, as the context plugin writes it. */
function deviceEntry(root, device) {
  return {
    device,
    software: device,
    directory: join(root, 'source', device),
    manifest: join(root, 'source', device, '_tia-openness-manifest.json'),
    exported: { blocks: 3, types: 0, tagTables: 1 },
    skipped: 0,
  }
}

const NO_SIGNAL = { signal: new AbortController().signal }
const execWithCwd = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })

test('an empty workspace reports no project, no devices and nothing to warn about', async () => {
  const root = makeRoot('empty')
  const report = await workspace.discoverWorkspace(root)

  assert.equal(report.workspaceRoot, root)
  assert.equal(report.project, null)
  assert.deepEqual(report.devices, [])
  assert.deepEqual(report.warnings, [], 'a workspace without a project is the normal state, not a warning')
})

test('a project with one built database reports it with size, mtime and where it came from', async () => {
  const root = makeRoot('one')
  writeIndex(root, { name: 'PEI_SinoARP_SWT2', savedAs: join(root, 'tia', 'ws', 'ws.ap17') }, [deviceEntry(root, 'Sino_PEI')])
  const expected = writeDatabase(root, 'Sino_PEI', 'Sino_PEI_knowledge.db')

  const report = await workspace.discoverWorkspace(root)

  assert.equal(report.project.name, 'PEI_SinoARP_SWT2')
  assert.equal(report.project.exportedAt, '2026-10-19T09:00:00.000Z')
  assert.equal(report.devices.length, 1)

  const [device] = report.devices
  assert.equal(device.device, 'Sino_PEI')
  assert.equal(device.database, expected)
  assert.equal(device.exists, true)
  assert.equal(device.bytes, 2048)
  assert.match(device.modifiedAt, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(device.deviceDir, join(root, 'source', 'Sino_PEI'))
  assert.equal(device.origin, 'index')
  assert.deepEqual(report.warnings, [])
})

test('a device with no database yet still reports the path it should have and where to build it from', async () => {
  const root = makeRoot('missing-db')
  writeIndex(root, { name: 'P', savedAs: null }, [deviceEntry(root, 'Sino_PEI')])

  const report = await workspace.discoverWorkspace(root)

  assert.equal(report.devices.length, 1)
  assert.equal(report.devices[0].exists, false)
  assert.equal(report.devices[0].bytes, null)
  assert.equal(report.devices[0].modifiedAt, null)
  assert.equal(report.devices[0].database, join(root, 'knowledge', 'Sino_PEI', 'Sino_PEI_knowledge.db'))
  assert.equal(report.devices[0].deviceDir, join(root, 'source', 'Sino_PEI'))
})

test('SQLite side files are never databases', async () => {
  const root = makeRoot('side-files')
  writeIndex(root, { name: 'P', savedAs: null }, [deviceEntry(root, 'PLC_1')])
  const path = writeDatabase(root, 'PLC_1', 'PLC_1_knowledge.db')
  for (const side of ['-wal', '-shm', '-journal']) writeFileSync(`${path}${side}`, 'scratch')

  const report = await workspace.discoverWorkspace(root)

  assert.equal(report.devices.length, 1)
  assert.equal(report.devices[0].database, path)
  assert.deepEqual(report.warnings, [])
})

test('a database the index does not list is reported, with a stale-index warning', async () => {
  const root = makeRoot('stale-index')
  writeIndex(root, { name: 'P', savedAs: null }, [deviceEntry(root, 'PLC_1')])
  writeDatabase(root, 'PLC_1', 'PLC_1_knowledge.db')
  mkdirSync(join(root, 'source', 'PLC_2'), { recursive: true })
  const orphan = writeDatabase(root, 'PLC_2', 'PLC_2_knowledge.db')

  const report = await workspace.discoverWorkspace(root)

  assert.deepEqual(report.devices.map((device) => device.device), ['PLC_1', 'PLC_2'])
  const extra = report.devices[1]
  assert.equal(extra.database, orphan)
  assert.equal(extra.exists, true)
  assert.equal(extra.deviceDir, join(root, 'source', 'PLC_2'))
  assert.equal(extra.origin, 'directory')
  assert.equal(report.warnings.length, 1)
  assert.match(report.warnings[0], /not listed in .*_dsh-engineering-context\.json/u)
})

test('a corrupt index degrades to "no project" with a warning, and the databases are still reported', async () => {
  const root = makeRoot('corrupt-index')
  mkdirSync(join(root, 'source'), { recursive: true })
  writeFileSync(join(root, 'source', '_dsh-engineering-context.json'), '{ this is not json', 'utf8')
  const path = writeDatabase(root, 'PLC_1', 'PLC_1_knowledge.db')

  const report = await workspace.discoverWorkspace(root)

  assert.equal(report.project, null)
  assert.equal(report.devices.length, 1, 'the database on disk is what the caller asked about')
  assert.equal(report.devices[0].database, path)
  assert.equal(report.devices[0].origin, 'directory')
  assert.ok(report.warnings.some((warning) => /not valid JSON/u.test(warning)))
})

test('a database at the top of knowledge/ is off-convention: warned about, not silently dropped', async () => {
  const root = makeRoot('stray-db')
  mkdirSync(join(root, 'knowledge'), { recursive: true })
  writeFileSync(join(root, 'knowledge', 'plc-knowledge.db'), 'x')

  const report = await workspace.discoverWorkspace(root)

  assert.deepEqual(report.devices, [])
  assert.equal(report.warnings.length, 1)
  assert.match(report.warnings[0], /databases belong in knowledge\/<device>\//u)
})

test('one existing database is the default; none and several are refusals that name what exists', async () => {
  const one = makeRoot('resolve-one')
  writeIndex(one, { name: 'P', savedAs: null }, [deviceEntry(one, 'PLC_1')])
  const only = writeDatabase(one, 'PLC_1', 'PLC_1_knowledge.db')
  const single = workspace.resolveDatabasePath(await workspace.discoverWorkspace(one))
  assert.deepEqual(single, { ok: true, path: only, device: 'PLC_1' })

  const none = makeRoot('resolve-none')
  writeIndex(none, { name: 'P', savedAs: null }, [deviceEntry(none, 'PLC_1')])
  const missing = workspace.resolveDatabasePath(await workspace.discoverWorkspace(none))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'DB_NOT_FOUND')
  assert.match(missing.remediation, /knowledge_ingest \(device_dir: /u, 'the remediation names the exact next call')
  assert.deepEqual(missing.candidates, [])

  const many = makeRoot('resolve-many')
  writeIndex(many, { name: 'P', savedAs: null }, [deviceEntry(many, 'PLC_1'), deviceEntry(many, 'PLC_2')])
  const first = writeDatabase(many, 'PLC_1', 'PLC_1_knowledge.db')
  const second = writeDatabase(many, 'PLC_2', 'PLC_2_knowledge.db')
  const ambiguous = workspace.resolveDatabasePath(await workspace.discoverWorkspace(many))
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'DB_AMBIGUOUS')
  assert.deepEqual([...ambiguous.candidates].sort(), [first, second].sort())
  assert.match(ambiguous.remediation, /Pass db_path explicitly/u)
  assert.match(ambiguous.message, /PLC_1, PLC_2/u)
})

test('an empty workspace refusal tells the caller to create a project instead of naming a device', async () => {
  const root = makeRoot('resolve-empty')
  const resolution = workspace.resolveDatabasePath(await workspace.discoverWorkspace(root))

  assert.equal(resolution.ok, false)
  assert.equal(resolution.code, 'DB_NOT_FOUND')
  assert.match(resolution.remediation, /create_engineering_project/u)
})

test('paths inside the workspace render relative with forward slashes; outside stays absolute', async () => {
  const root = makeRoot('portable')
  assert.equal(workspace.portablePath(root, join(root, 'knowledge', 'PLC_1', 'PLC_1_knowledge.db')), 'knowledge/PLC_1/PLC_1_knowledge.db')
  assert.equal(workspace.portablePath(root, 'D:\\elsewhere\\plc-knowledge.db'), 'D:\\elsewhere\\plc-knowledge.db')
})

test('sizes render as the one number a model needs', () => {
  assert.equal(workspace.renderBytes(null), null)
  assert.equal(workspace.renderBytes(512), '512 B')
  assert.equal(workspace.renderBytes(2048), '2.0 KB')
  assert.equal(workspace.renderBytes(450 * 1024 * 1024), '450.0 MB')
})

test('knowledge_workspace reports the project, its devices and the next step, and never calls the engine', async () => {
  const root = makeRoot('tool-ok')
  writeIndex(root, { name: 'PEI_SinoARP_SWT2', savedAs: join(root, 'tia', 'ws', 'ws.ap17') }, [deviceEntry(root, 'Sino_PEI')])
  writeDatabase(root, 'Sino_PEI', 'Sino_PEI_knowledge.db')

  const tools = await loadToolsModule()
  const context = createTestContext()
  const calls = []
  tools.registerTools(context.ctx, {
    request: async (operation) => {
      calls.push(operation)
      throw new Error('knowledge_workspace must not need the engine')
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_workspace')
  const value = await executeTool(definition, {}, execWithCwd(root))

  assert.deepEqual(calls, [])
  assert.equal(value.ok, true)
  assert.equal(value.tool, 'knowledge_workspace')
  assert.match(value.summary, /PEI_SinoARP_SWT2: 1 device\(s\), 1 with a knowledge database/u)

  const details = value.details.join('\n')
  assert.match(details, /knowledge\/Sino_PEI\/Sino_PEI_knowledge\.db — 2\.0 KB/u)
  assert.match(details, /Next step: knowledge_query resolves db_path/u)
  assert.deepEqual(value.data.devices.map((device) => device.database), ['knowledge/Sino_PEI/Sino_PEI_knowledge.db'])
})

test('knowledge_workspace with no working directory fails with a code, not a crash', async () => {
  const tools = await loadToolsModule()
  const context = createTestContext()
  tools.registerTools(context.ctx, {
    request: async () => {
      throw new Error('unreachable')
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_workspace')

  const value = await executeTool(definition, {}, NO_SIGNAL)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'WORKSPACE_UNAVAILABLE')
  assert.match(value.error.remediation, /working directory/u)
})

test('knowledge_query resolves the single database when db_path is omitted', async () => {
  const root = makeRoot('query-one')
  writeIndex(root, { name: 'P', savedAs: null }, [deviceEntry(root, 'PLC_1')])
  const path = writeDatabase(root, 'PLC_1', 'PLC_1_knowledge.db')

  const tools = await loadToolsModule()
  const context = createTestContext()
  const calls = []
  tools.registerTools(context.ctx, {
    request: async (operation, params) => {
      calls.push({ operation, params })
      return { type: 'result', protocol: 1, ok: true, durationMs: 3, data: { dbPath: params.dbPath, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false } }
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_query')

  const value = await executeTool(definition, { sql: 'SELECT 1 AS n' }, execWithCwd(root))
  assert.equal(value.ok, true)
  assert.deepEqual(calls, [{ operation: 'Query', params: { dbPath: path, sql: 'SELECT 1 AS n' } }])
})

test('knowledge_query refuses to guess between devices, and the engine is never asked', async () => {
  const root = makeRoot('query-many')
  writeIndex(root, { name: 'P', savedAs: null }, [deviceEntry(root, 'PLC_1'), deviceEntry(root, 'PLC_2')])
  writeDatabase(root, 'PLC_1', 'PLC_1_knowledge.db')
  writeDatabase(root, 'PLC_2', 'PLC_2_knowledge.db')

  const tools = await loadToolsModule()
  const context = createTestContext()
  const calls = []
  tools.registerTools(context.ctx, {
    request: async (operation) => {
      calls.push(operation)
      throw new Error('a refused query must not reach the engine')
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_query')
  const value = await executeTool(definition, { sql: 'SELECT 1' }, execWithCwd(root))

  assert.deepEqual(calls, [])
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'DB_AMBIGUOUS')
  assert.match(value.error.message, /2 knowledge databases/u)
  assert.match(value.error.details.remediation, /Pass db_path explicitly/u)
})
