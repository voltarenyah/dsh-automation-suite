/**
 * Tests for the pure client model: rows from the host snapshots, filtering,
 * the tag tree, and the ledger totals. The module is plain ESM, so the tests
 * import the source directly (the browser bundle is not needed here).
 *
 * @module dsh-ui-project-dashboard/test/model
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRows,
  decorateRows,
  filterRows,
  normalizeTagInput,
  summarize,
  tagMatches,
  tagTree,
} from '../src/client/model.js'

const NOW = Date.parse('2026-11-05T06:00:00Z')

/** @returns the two-workspace fixture. */
function fixture() {
  const workspaces = [
    {
      workspaceId: 'ws-a',
      title: 'SWT1',
      path: 'C:\\projects\\SWT1',
      createdAt: '2026-11-04T03:00:00Z',
      sessionIds: ['s1', 's2', 's3'],
    },
    {
      workspaceId: 'ws-b',
      title: 'SWT2',
      path: 'C:\\projects\\SWT2',
      createdAt: '2026-10-01T03:00:00Z',
      sessionIds: ['s4'],
    },
    { workspaceId: 'ws-c', title: 'empty', path: 'C:\\projects\\empty', createdAt: '2026-10-02T03:00:00Z', sessionIds: [] },
  ]
  const byId = {
    s1: { id: 's1', title: 'a', blank: false, updatedAt: NOW - 60_000, running: true },
    s2: { id: 's2', title: 'b', blank: true, updatedAt: NOW - 3_600_000, running: false },
    s3: { id: 's3', title: 'c', blank: false, updatedAt: NOW - 5_000_000, running: false },
    s4: { id: 's4', title: 'd', blank: false, updatedAt: NOW - 90_000_000, running: false },
  }
  const statuses = new Map([
    ['s1', { running: true, pendingInteraction: null, completionUnread: false }],
    ['s3', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: true }],
  ])
  return { workspaces, sessions: { ids: Object.keys(byId), byId }, statuses, archived: ['s4'] }
}

test('normalizeTagInput trims, collapses slashes and enforces limits', () => {
  assert.equal(normalizeTagInput('  客户 / PEI '), '客户/PEI')
  assert.equal(normalizeTagInput('a//b'), 'a/b')
  assert.equal(normalizeTagInput('a/b/c/d'), 'a/b/c/d')
  assert.equal(normalizeTagInput('a/b/c/d/e'), null)
  assert.equal(normalizeTagInput('   '), null)
  assert.equal(normalizeTagInput('x'.repeat(41)), null)
  assert.equal(normalizeTagInput(42), null)
})

test('buildRows joins sessions, status, archive and blank counts', () => {
  const { workspaces, sessions, statuses, archived } = fixture()
  const rows = buildRows(workspaces, sessions, statuses, archived)
  assert.equal(rows.length, 3)
  const [a, b, c] = rows
  assert.equal(a.sessions, 3)
  assert.equal(a.running, 1)
  assert.equal(a.pending, 1)
  assert.equal(a.blank, 1)
  assert.equal(a.archived, 0)
  assert.equal(a.lastAt, NOW - 60_000)
  assert.equal(b.archived, 1)
  assert.equal(b.running, 0)
  assert.equal(c.sessions, 0)
  assert.equal(c.lastAt, Date.parse('2026-10-02T03:00:00Z'))})

test('decorateRows attaches tags by workspace id', () => {
  const { workspaces, sessions, statuses, archived } = fixture()
  const rows = decorateRows(buildRows(workspaces, sessions, statuses, archived), {
    'ws-a': { path: '', tags: ['客户/PEI'], updatedAt: '' },
  })
  assert.deepEqual(rows[0].tags, ['客户/PEI'])
  assert.deepEqual(rows[1].tags, [])
})

test('tagMatches includes descendants but not siblings', () => {
  const tags = ['产线/焊装/HF48e', '阶段/试产']
  assert.equal(tagMatches(tags, '产线'), true)
  assert.equal(tagMatches(tags, '产线/焊装'), true)
  assert.equal(tagMatches(tags, '产线/焊装/HF48e'), true)
  assert.equal(tagMatches(tags, '产线/涂装'), false)
  assert.equal(tagMatches(tags, '阶段'), true)
})

test('filterRows combines free text and tag filters', () => {
  const { workspaces, sessions, statuses, archived } = fixture()
  const rows = decorateRows(buildRows(workspaces, sessions, statuses, archived), {
    'ws-a': { path: '', tags: ['产线/焊装/HF48e'], updatedAt: '' },
    'ws-b': { path: '', tags: ['产线/焊装/SWT2'], updatedAt: '' },
  })
  assert.equal(filterRows(rows, '', []).length, 3)
  assert.equal(filterRows(rows, 'SWT1', []).length, 1)
  assert.equal(filterRows(rows, 'projects', []).length, 3)
  assert.equal(filterRows(rows, '', ['产线/焊装']).length, 2)
  assert.equal(filterRows(rows, 'SWT2', ['产线/焊装']).length, 1)
  assert.equal(filterRows(rows, 'SWT2', ['阶段']).length, 0)
  assert.equal(filterRows(rows, 'hf48e', ['产线']).length, 1)
})

test('tagTree counts workspaces per prefix and sorts by path', () => {
  const { workspaces, sessions, statuses, archived } = fixture()
  const rows = decorateRows(buildRows(workspaces, sessions, statuses, archived), {
    'ws-a': { path: '', tags: ['产线/焊装/HF48e', '阶段/试产'], updatedAt: '' },
    'ws-b': { path: '', tags: ['产线/焊装/SWT2', '阶段/量产'], updatedAt: '' },
    'ws-c': { path: '', tags: ['产线/焊装/HF48e'], updatedAt: '' },
  })
  const tree = tagTree(rows)
  const counts = Object.fromEntries(tree.map((node) => [node.path, node.count]))
  assert.equal(counts['产线'], 3)
  assert.equal(counts['产线/焊装'], 3)
  assert.equal(counts['产线/焊装/HF48e'], 2)
  assert.equal(counts['阶段'], 2)
  assert.equal(counts['阶段/试产'], 1)
  const paths = tree.map((node) => node.path)
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, 'zh-CN')))
})

test('summarize totals the visible rows only', () => {
  const { workspaces, sessions, statuses, archived } = fixture()
  const rows = buildRows(workspaces, sessions, statuses, archived)
  const totals = summarize(rows)
  assert.deepEqual(totals, { workspaces: 3, sessions: 4, archived: 1, running: 1, pending: 1 })
  const filtered = summarize(filterRows(decorateRows(rows, {}), 'SWT2', []))
  assert.equal(filtered.workspaces, 1)
  assert.equal(filtered.sessions, 1)
  assert.equal(filtered.archived, 1)
})
