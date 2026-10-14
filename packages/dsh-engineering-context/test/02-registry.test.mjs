/**
 * The registry file: round-trip, validation and selection.
 *
 * A registry that does not validate must be reported, never rewritten: silently
 * rebuilding it would discard the user's registrations.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfigModule, loadRegistryModule, makeFile, tempWorkspace } from './helpers/harness.mjs'

const { resolveConfig } = await loadConfigModule()
const registry = await loadRegistryModule()
const config = resolveConfig()

test('a missing registry is reported as missing, not as an error', async (t) => {
  const root = await tempWorkspace(t)
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'missing')
  assert.equal(state.file, join(root, '_dsh-eng', 'projects.json'))
})

test('write then read round-trips, and leaves no temporary file behind', async (t) => {
  const root = await tempWorkspace(t)
  const document = {
    schemaVersion: registry.REGISTRY_SCHEMA_VERSION,
    workspacePath: root,
    current: 'p',
    projects: [
      {
        id: 'p',
        title: 'P',
        source: null,
        work: 'projects/p/work/p.ap17',
        export: 'projects/p/export',
        createdAt: '2026-01-01T00:00:00.000Z',
        adoptedAt: null,
      },
    ],
  }
  const file = await registry.writeRegistry(config, root, document)
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'ok')
  assert.deepEqual(state.document, document)

  const entries = await readdir(join(root, '_dsh-eng'))
  assert.deepEqual(entries, ['projects.json'], 'the atomic write must not leave its temporary file behind')
  assert.match(await readFile(file, 'utf8'), /"schemaVersion": 1/u)
})

test('an unparsable registry is reported and left untouched', async (t) => {
  const root = await tempWorkspace(t)
  const file = await makeFile(join(root, '_dsh-eng', 'projects.json'), '{ not json')
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'invalid')
  assert.match(state.reason, /not valid JSON/u)
  assert.equal(await readFile(file, 'utf8'), '{ not json')
})

test('a registry with a foreign schema version is refused', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(
    join(root, '_dsh-eng', 'projects.json'),
    JSON.stringify({ schemaVersion: 99, workspacePath: root, current: null, projects: [] }),
  )
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'invalid')
  assert.match(state.reason, /unsupported schemaVersion 99/u)
})

test('duplicate project ids are refused', async (t) => {
  const root = await tempWorkspace(t)
  const record = {
    id: 'p',
    title: 'P',
    source: null,
    work: 'w',
    export: 'e',
    createdAt: 'now',
    adoptedAt: null,
  }
  await makeFile(
    join(root, '_dsh-eng', 'projects.json'),
    JSON.stringify({ schemaVersion: 1, workspacePath: root, current: null, projects: [record, record] }),
  )
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'invalid')
  assert.match(state.reason, /appears twice/u)
})

test('a malformed project record is refused with its index', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(
    join(root, '_dsh-eng', 'projects.json'),
    JSON.stringify({ schemaVersion: 1, workspacePath: root, current: null, projects: [{ id: 'p' }] }),
  )
  const state = await registry.readRegistry(config, root)
  assert.equal(state.status, 'invalid')
  assert.match(state.reason, /projects\[0\]/u)
})

test('selectProject prefers the current pointer, then the only project, else reports ambiguity', () => {
  const base = { schemaVersion: 1, workspacePath: '/w', current: null, projects: [] }
  const a = { id: 'a', title: 'A', source: null, work: 'a', export: 'a', createdAt: 'now', adoptedAt: null }
  const b = { ...a, id: 'b', title: 'B', work: 'b', export: 'b' }

  assert.deepEqual(registry.selectProject(base), { none: true })
  assert.deepEqual(registry.selectProject({ ...base, projects: [a] }), { record: a })
  assert.deepEqual(registry.selectProject({ ...base, projects: [a, b] }), { ambiguous: true })
  assert.deepEqual(registry.selectProject({ ...base, projects: [a, b], current: 'b' }), { record: b })
  // A current pointer naming a project that is gone falls back rather than lying.
  assert.deepEqual(registry.selectProject({ ...base, projects: [a], current: 'missing' }), { record: a })
})
