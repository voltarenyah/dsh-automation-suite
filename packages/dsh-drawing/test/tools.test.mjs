/**
 * Tool-level behaviour, driven through the real `apply()` and the registered
 * definitions — the same surface the model sees.
 *
 * A hand-written mini index keeps this fast and independent of the parser: the
 * parser has its own baseline test. What is under test here is the contract —
 * argument handling, error shape, and the fact that `drawing_show` carries a
 * page + box for the sidebar without shipping page text to the model.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerTools } from '../lib/tools/index.js'

const SHEETS = [
  { cabinet: 1, sheet: 210, page: 25, title: 'AG : 8 SAFETY LOGICAL INPUTS', template: 'schematic', loc: 'AG', prev: 201, next: 211 },
  { cabinet: 1, sheet: 3000, page: 58, title: 'Cable : W021,W025', template: 'cable', loc: null, prev: 604, next: 3001 },
  { cabinet: 2, sheet: 210, page: 98, title: 'BASE-A : SAFETY OUTPUTS', template: 'schematic', loc: 'COF-BASE-A', prev: 201, next: 220 },
]

const XREFS = [
  { page: 25, sheet: 210, raw: '(220-14)', target: 220, column: 14, side: null, targetPage: 27, targetCabinet: 1, x: 120, y: 300 },
  { page: 25, sheet: 210, raw: '(1899-3)', target: 1899, column: 3, side: null, targetPage: null, targetCabinet: null, x: 130, y: 300 },
]

const NAMES = {
  '220KA3': {
    kind: 'tag',
    occurrences: [
      { page: 25, sheet: 210, x: 108.6, y: 249.2, w: 25.8, h: 8, role: 'tag' },
      { page: 27, sheet: 220, x: 339.4, y: 369.4, w: 25.8, h: 8, role: 'tag' },
    ],
  },
  W015: {
    kind: 'cable',
    occurrences: [{ page: 25, sheet: 210, x: 358.1, y: 242.1, w: 26, h: 8, role: 'cable' }],
  },
}

const PROFILE = {
  document: 'demo.pdf',
  sha256: 'deadbeef',
  pages: 100,
  parsedAt: '2026-11-03T00:00:00.000Z',
  parserVersion: 1,
  vendor: 'SEE Electrical 4.80',
  project: { name: 'DEMO PROJECT', number: '19126-17800-MPE', revision: 'D', date: '2019/10/28' },
  cabinets: [
    { id: 1, name: 'AG', pages: [1, 50], sheets: 40 },
    { id: 2, name: 'COF-BASE-A', pages: [51, 100], sheets: 39 },
  ],
  templates: { schematic: 2, cable: 1 },
  numbering: { '200-299': 'PLC 通道' },
  indexes: ['sheets', 'xrefs', 'names'],
  quality: { xrefs: 2, xrefsResolved: 1 },
  caveats: ['目录（SUMMARY）列出 3 个纸面上不存在的图号'],
}

/** Lay out a workspace with one finished index. */
async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-drawing-tools-'))
  const drawingDir = join(root, 'drawing')
  const dir = join(drawingDir, 'demo')
  await mkdir(join(dir, 'index'), { recursive: true })
  await mkdir(join(root, '.dsh'), { recursive: true })
  await writeFile(join(drawingDir, 'demo.pdf'), '%PDF-1.4 test')
  await writeFile(join(dir, 'profile.json'), JSON.stringify(PROFILE))
  await writeFile(join(dir, 'build.json'), JSON.stringify({ sha256: 'deadbeef', parserVersion: 1 }))
  await writeFile(join(dir, 'index', 'sheets.json'), JSON.stringify(SHEETS))
  await writeFile(join(dir, 'index', 'xrefs.json'), JSON.stringify(XREFS))
  await writeFile(join(dir, 'index', 'names.json'), JSON.stringify(NAMES))
  await writeFile(
    join(root, '.dsh', 'drawing-manifest.json'),
    JSON.stringify({ documents: [{ file: 'demo.pdf', dir, pages: 100, indexed: true }] }),
  )
  return root
}

/** Boot the plugin against a fake context and return the tool registry. */
function boot(cwd) {
  const definitions = new Map()
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    logger: Object.assign(() => ctx.logger, { debug() {}, info() {}, warn() {}, error() {} }),
    get() {
      return undefined
    },
    effect(setup) {
      const dispose = setup()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  // Drive the tool registrations directly: the plugin entry also loads the
  // schemastery-backed `Config`, which only the host runtime resolves.
  registerTools((definition) => ctx.tools.register(definition), {
    settings: { dir: 'drawing' },
    log: ctx.logger,
  })
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd } } } }
  const call = (name, args) => definitions.get(name).execute(args, exec)
  return { call, names: [...definitions.keys()] }
}

test('registers exactly the five P0 tools', async () => {
  const cwd = await makeWorkspace()
  const { names } = boot(cwd)
  assert.deepEqual(names, ['drawing_status', 'drawing_open', 'drawing_search', 'drawing_sheet', 'drawing_show'])
})

test('drawing_status lists the indexed drawing and writes the panel manifest', async () => {
  const cwd = await makeWorkspace()
  const { call } = boot(cwd)
  const status = await call('drawing_status', {})
  assert.equal(status.ok, true)
  assert.equal(status.documents.length, 1)
  assert.equal(status.documents[0].file, 'demo.pdf')
  assert.equal(status.documents[0].indexed, true)
  assert.match(status.hint, /drawing_search/)
})

test('drawing_search finds a tag by exact name and reports its boxes', async () => {
  const cwd = await makeWorkspace()
  const { call } = boot(cwd)
  const found = await call('drawing_search', { query: '220KA3' })
  assert.equal(found.ok, true)
  assert.equal(found.total, 2)
  assert.deepEqual(found.hits.map((hit) => hit.page).sort(), [25, 27])
  assert.equal(found.hits[0].kind, 'tag')
  assert.ok(typeof found.hits[0].x === 'number')
})

test('drawing_search resolves a cross reference and marks unresolved targets', async () => {
  const cwd = await makeWorkspace()
  const { call } = boot(cwd)
  const found = await call('drawing_search', { query: '(220-14)', kind: 'xref' })
  assert.equal(found.ok, true)
  assert.equal(found.total, 1)
  assert.equal(found.hits[0].targetPage, 27)
  assert.equal(found.hits[0].column, 14)

  const dangling = await call('drawing_search', { query: '(1899-3)', kind: 'xref' })
  assert.equal(dangling.hits[0].targetPage, null)
  assert.match(dangling.hits[0].detail, /不可解析/)
})

test('drawing_sheet needs a cabinet when a sheet number repeats', async () => {
  const cwd = await makeWorkspace()
  const { call } = boot(cwd)
  const ambiguous = await call('drawing_sheet', { sheet: 210 })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.error, 'sheet_ambiguous')
  assert.equal(ambiguous.candidates.length, 2)

  const one = await call('drawing_sheet', { cabinet: 1, sheet: 210 })
  assert.equal(one.ok, true)
  assert.equal(one.page, 25)
  assert.equal(one.template, 'schematic')
  assert.ok(one.elements.some((element) => element.name === '220KA3'))
  assert.equal(one.xrefs.length, 2)
  assert.equal(one.incoming, 0)
})

test('drawing_show returns the location payload, not page text', async () => {
  const cwd = await makeWorkspace()
  const { call } = boot(cwd)
  const shown = await call('drawing_show', { cabinet: 1, sheet: 210, x: 108.6, y: 249.2, w: 25.8, h: 8, caption: '220KA3' })
  assert.equal(shown.ok, true)
  assert.equal(shown.page, 25)
  assert.deepEqual(shown.highlight, { x: 108.6, y: 249.2, w: 25.8, h: 8 })
  assert.equal(shown.caption, '220KA3')
  assert.equal('text' in shown, false)
})

test('tools report a usable error when the workspace has no drawing', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'dsh-drawing-empty-'))
  const { call } = boot(empty)
  const status = await call('drawing_status', {})
  assert.equal(status.ok, true)
  assert.deepEqual(status.documents, [])
  assert.match(status.hint, /drawing_open/)

  const sheet = await call('drawing_sheet', { page: 1 })
  assert.equal(sheet.ok, false)
  assert.equal(sheet.error, 'no_drawing')
})

