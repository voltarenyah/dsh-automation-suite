/**
 * P1 acceptance through the real tool surface (not the library):
 * ingest the 353-page drawing, then search / read a sheet / locate it.
 *
 * Run: node packages/dsh-drawing/scripts/smoke.mjs [pdfPath]
 */
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools } from '../lib/tools/index.js'

const require = createRequire(import.meta.url)
const cwd = await mkdtemp(join(tmpdir(), 'dsh-drawing-smoke-'))
const definitions = new Map()
const log = Object.assign(() => log, { debug() {}, info() {}, warn() {}, error() {} })
registerTools((definition) => {
  definitions.set(definition.name, definition)
  return () => {}
}, { settings: { dir: 'drawing' }, log })

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd } } } }
const call = (name, args) => definitions.get(name).execute(args, exec)

const source = process.argv[2] ?? 'C:\\Users\\Ansel\\Downloads\\PEI---SWT2_20260527.pdf'
const t0 = Date.now()
const opened = await call('drawing_open', { source })
console.log('drawing_open:', opened.ok, 'cached', opened.cached, 'ms', Date.now() - t0)
console.log('  pages', opened.pages, '| cabinets', opened.cabinets?.map((c) => `${c.id}:${c.name}`).join(' '))
console.log('  project', JSON.stringify(opened.project))
console.log('  quality', JSON.stringify(opened.quality))
console.log('  caveats', opened.caveats)

const again = await call('drawing_open', { source })
console.log('\ndrawing_open again: cached =', again.cached)

const found = await call('drawing_search', { query: 'W015' })
console.log('\ndrawing_search W015:', found.total, 'hit(s)')
for (const hit of found.hits) console.log(`  sheet ${hit.sheet} p${hit.page} ${hit.kind} ${hit.text} @(${Math.round(hit.x)},${Math.round(hit.y)})`)

const sheet = await call('drawing_sheet', { cabinet: 1, sheet: 210 })
console.log('\ndrawing_sheet 1/210:', sheet.ok, sheet.title, '| elements', sheet.elements?.length, '| xrefs', sheet.xrefs?.length, '| incoming', sheet.incoming)
console.log('  first elements:', (sheet.elements ?? []).slice(0, 5).map((e) => `${e.kind}:${e.name}`).join(' '))
console.log('  first xrefs   :', (sheet.xrefs ?? []).slice(0, 4).map((x) => `${x.raw}->p${x.targetPage}`).join(' '))

const shown = await call('drawing_show', { cabinet: 1, sheet: 210, x: 358, y: 242, w: 30, h: 8, caption: 'W015' })
console.log('\ndrawing_show:', shown.ok, 'page', shown.page, 'highlight', JSON.stringify(shown.highlight))
console.log('  image:', JSON.stringify(shown.image))
const view = JSON.parse(require('node:fs').readFileSync(join(cwd, '.dsh', 'drawing-view.json'), 'utf8'))
console.log('  view file:', view.document, 'p' + view.page, 'image?', view.image !== null)
console.log('  png bytes:', require('node:fs').statSync(view.image.path).size)

const payload = definitions.get('drawing_search').output.render({}, found)
console.log('\nrender(search) →', payload[0].text.split('\n').slice(0, 3).join('\n'))

