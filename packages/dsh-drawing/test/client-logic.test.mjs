/**
 * Client-side linkage logic, tested without a browser.
 *
 * The two pieces that decide whether `drawing_show` reaches the sidebar are pure
 * enough to drive directly: the per-session view store, and the `sidebarRight`
 * call sequence (open → focus → expand) including the polite paths. The React
 * components on top only wire these to props.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getView, setView, subscribeView } from '../src/client/store.js'
import { openDrawingTab, rightFace } from '../src/client/open-tab.js'

/** A `sidebarRight` face that records the calls it receives. */
function fakeSidebar(options = {}) {
  const calls = []
  const face = {
    openTab: (kind) => {
      calls.push(['openTab', kind])
      if (options.throwOnOpen === true) throw new Error('sidebarRight: no session surface is mounted')
      if (options.tabExists !== false) {
        face.openTabs.rows.push({ sessionId: 's1', kind, tabId: 'tab-1' })
      }
    },
    focus: (tabId) => calls.push(['focus', tabId]),
    active: () => options.active ?? null,
    isExpanded: () => options.expanded === true,
    toggleExpanded: () => calls.push(['toggleExpanded']),
    mounted: { getSnapshot: () => options.mounted ?? 's1', subscribe: () => () => {} },
    openTabs: { rows: [], getSnapshot() { return this.rows }, subscribe: () => () => {} },
  }
  const ctx = { get: (name) => (name === 'sidebarRight' ? face : undefined) }
  return { ctx, calls }
}

test('the view store publishes a change once per stamp', () => {
  const seen = []
  const stop = subscribeView('sess-a', () => seen.push(getView('sess-a')?.page))
  setView('sess-a', { ts: 't1', page: 25 })
  setView('sess-a', { ts: 't1', page: 25 }) // same stamp: no second publish
  setView('sess-a', { ts: 't2', page: 27 })
  stop()
  setView('sess-a', { ts: 't3', page: 30 }) // after unsubscribe
  assert.deepEqual(seen, [25, 27])
  assert.equal(getView('sess-a').page, 30)
})

test('rightFace refuses a service that is missing a member', () => {
  const partial = { get: () => ({ openTab() {}, focus() {} }) }
  assert.equal(rightFace(partial), undefined)
  const full = fakeSidebar()
  assert.ok(rightFace(full.ctx) !== undefined)
})

test('openDrawingTab opens, focuses and expands the sidebar', () => {
  const { ctx, calls } = fakeSidebar({ expanded: false })
  const result = openDrawingTab(ctx, 'drawing', 's1')
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], ['openTab', 'drawing'])
  assert.deepEqual(calls[1], ['focus', 'tab-1'])
  assert.deepEqual(calls[2], ['toggleExpanded'])
})

test('openDrawingTab does not steal a column showing another page', () => {
  const { ctx, calls } = fakeSidebar({ expanded: true, active: { kind: 'files', id: 'x' } })
  const result = openDrawingTab(ctx, 'drawing', 's1')
  assert.equal(result.ok, true)
  assert.equal(result.stolen, true)
  assert.equal(
    calls.some(([name]) => name === 'focus'),
    false,
    'focus would pull the reader off their page',
  )
})

test('openDrawingTab reports the mid-switch state instead of throwing', () => {
  const { ctx } = fakeSidebar({ throwOnOpen: true })
  assert.deepEqual(openDrawingTab(ctx, 'drawing', 's1'), { ok: false, reason: 'surface_transition' })
})

test('openDrawingTab stays put when another session is on screen', () => {
  const { ctx, calls } = fakeSidebar({ mounted: 'other-session' })
  assert.deepEqual(openDrawingTab(ctx, 'drawing', 's1'), { ok: false, reason: 'session_not_mounted' })
  assert.deepEqual(calls, [])
})
