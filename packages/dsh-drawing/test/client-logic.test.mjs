/**
 * Client-side linkage logic, tested without a browser.
 *
 * The pieces that decide whether `drawing_show` reaches the sidebar and which
 * page the PDF viewer shows are pure enough to drive directly: the per-session
 * view store, the `sidebarRight` call sequence (open → focus → expand), and the
 * single-surface page helpers. The React components on top only wire these to
 * props.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getView, setView, subscribeView } from '../src/client/store.js'
import { openDrawingTab, rightFace } from '../src/client/open-tab.js'
import { clampPage, fitZoom, pdfSrc, pickDocument, resolvePage, viewDocument } from '../src/client/view-state.js'

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

test('clampPage keeps a page inside the document', () => {
  assert.equal(clampPage(0, 353), 1)
  assert.equal(clampPage(400, 353), 353)
  assert.equal(clampPage(30, 353), 30)
  assert.equal(clampPage(30, null), 30, 'unknown page count does not clamp the top')
  assert.equal(clampPage(undefined, 353), 1)
})

test('resolvePage: explicit pick wins, then the agent page, then the first sheet', () => {
  const view = { ts: 't', document: 'a.pdf', page: 25, sheet: 210 }
  const sheets = [{ page: 3, sheet: null }, { page: 25, sheet: 210 }]
  const base = { view, documentFile: 'a.pdf', sheets, pages: 353 }

  assert.equal(resolvePage({ ...base, targetPage: 58 }), 58, 'the list click wins')
  assert.equal(resolvePage({ ...base, targetPage: null }), 25, 'agent page for the same document')
  assert.equal(
    resolvePage({ ...base, documentFile: 'b.pdf', targetPage: null }),
    3,
    "another document must not inherit the agent's page",
  )
  assert.equal(resolvePage({ ...base, view: undefined, targetPage: null }), 3, 'first sheet otherwise')
  assert.equal(resolvePage({ ...base, view: undefined, sheets: [], targetPage: null }), 1, 'and page 1 without an index')
})

test('pickDocument follows the agent, then the first indexed drawing', () => {
  const documents = [
    { file: 'a.pdf', indexed: false },
    { file: 'b.pdf', indexed: true },
  ]
  assert.equal(pickDocument(documents, { document: 'a.pdf' })?.file, 'a.pdf', 'the agent view wins')
  assert.equal(pickDocument(documents, { document: 'gone.pdf' })?.file, 'b.pdf', 'stale view falls back')
  assert.equal(pickDocument(documents, undefined)?.file, 'b.pdf')
  assert.equal(pickDocument([{ file: 'a.pdf' }], undefined)?.file, 'a.pdf')
  assert.equal(pickDocument([], undefined), undefined)
})

test('viewDocument only accepts a document still in the manifest', () => {
  const documents = [{ file: 'a.pdf' }, { file: 'b.pdf' }]
  assert.equal(viewDocument({ document: 'b.pdf' }, documents), 'b.pdf')
  assert.equal(viewDocument({ document: 'gone.pdf' }, documents), undefined)
  assert.equal(viewDocument({}, documents), undefined)
})

test('pdfSrc builds the page fragment the viewer honours on mount', () => {
  assert.equal(pdfSrc('blob:http://host/abc', 30), 'blob:http://host/abc#page=30')
  assert.equal(pdfSrc('blob:http://host/abc', 30, 71), 'blob:http://host/abc#page=30&zoom=71,0,0')
  assert.equal(pdfSrc('blob:http://host/abc', 0), 'blob:http://host/abc#page=1')
  assert.equal(pdfSrc('', 3), undefined)
  assert.equal(pdfSrc(undefined, 3), undefined)
})

test('fitZoom turns the page width into a readable pane zoom', () => {
  assert.equal(fitZoom(842, 604), 71, 'landscape sheet fills a 604px pane')
  assert.equal(fitZoom(595, 604), 101, 'portrait sheet fit')
  assert.equal(fitZoom(1000, 604), 60)
  assert.equal(fitZoom(5000, 604), 25, 'floor at the viewer minimum')
  assert.equal(fitZoom(100, 604), 200, 'ceiling for tiny pages')
  assert.equal(fitZoom(842, 0), undefined, 'not measured yet')
  assert.equal(fitZoom(undefined, 604), undefined)
  assert.equal(fitZoom(0, 604), undefined)
})
