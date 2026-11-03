/**
 * Baseline test: parse the real drawing set and compare against the numbers the
 * research phase measured with an independent stack (PDFium, via Python).
 *
 * Skipped — not failed — when the PDF is not on this machine, so a fresh
 * checkout and CI still pass; the skip message says how to enable it.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openDrawing, loadIndex } from '../lib/indexer/build.js'
import { renderPage } from '../lib/indexer/render.js'
import { documentDir } from '../lib/indexer/store.js'

const CANDIDATES = [
  process.env.DRAWING_TEST_PDF,
  'C:\\Users\\Ansel\\Downloads\\PEI---SWT2_20260527.pdf',
  'E:\\PEI---SWT2_20260527.pdf',
].filter((path) => typeof path === 'string' && path !== '')

const pdf = CANDIDATES.find((path) => existsSync(path))

test(
  'parses the SWT2 drawing set to the measured baseline',
  { skip: pdf === undefined ? 'drawing PDF not present; set DRAWING_TEST_PDF to enable' : false },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-drawing-'))
    const drawingDir = join(workspace, 'drawing')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(drawingDir, { recursive: true })
    const local = join(drawingDir, 'drawing.pdf')
    await copyFile(pdf, local)

    const first = await openDrawing(drawingDir, local)
    const { profile, sheets, xrefs, names } = first.index

    assert.equal(profile.pages, 353)
    assert.equal(sheets.filter((sheet) => sheet.sheet !== null).length, 350, 'sheet numbers found')
    assert.equal(profile.cabinets.length, 3, 'three print jobs / cabinets')
    assert.deepEqual(
      profile.cabinets.map((cabinet) => cabinet.name),
      ['AG', 'COF-BASE-A', 'COF-BASE-B'],
    )

    // Cross references: the research stack found 1669; the pdf.js run is a
    // different text segmentation, so assert the order of magnitude and that
    // resolution stays as complete as before.
    assert.ok(xrefs.length > 1200, `xrefs ${xrefs.length}`)
    const resolved = xrefs.filter((xref) => xref.targetPage !== null).length
    assert.ok(resolved / xrefs.length > 0.85, `resolved ${resolved}/${xrefs.length}`)

    // Named elements: tags, wires, cables, addresses, terminals.
    assert.ok(Object.keys(names).length > 800, `names ${Object.keys(names).length}`)
    assert.ok(names['220KA3'] !== undefined, 'known relay tag is indexed')
    const w015 = Object.entries(names).find(([name]) => name === 'W015')
    assert.ok(w015 !== undefined, 'known cable is indexed')

    // The stale-SUMMARY caveat must be reproduced automatically.
    assert.ok(
      profile.caveats.some((caveat) => caveat.includes('SUMMARY')),
      `caveats: ${JSON.stringify(profile.caveats)}`,
    )

    // Every placed box must sit inside its page frame (the cheap P1 sanity gate).
    assert.ok(profile.quality.boxesInsidePage > 0.98, `boxesInsidePage ${profile.quality.boxesInsidePage}`)

    // Second call: cached, no reparse.
    const second = await openDrawing(drawingDir, local)
    assert.equal(second.cached, true)
    assert.equal(second.index.xrefs.length, xrefs.length)

    // P3: the page rasterises, and the image is a real PNG at the expected size.
    const rendered = await renderPage(documentDir(drawingDir, local), local, 25, 2)
    assert.equal(rendered.displayWidth, 842)
    assert.equal(rendered.displayHeight, 595)
    assert.equal(rendered.width, 1684)
    assert.equal(rendered.height, 1190)
    const png = await import('node:fs/promises').then((fs) => fs.readFile(rendered.path))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature')
    assert.ok(png.length > 50_000, `png bytes ${png.length}`)
    const againImage = await renderPage(documentDir(drawingDir, local), local, 25, 2)
    assert.equal(againImage.cached, true)

    // The index is readable from disk exactly as the tools read it.
    const reloaded = await loadIndex(documentDir(drawingDir, local))
    assert.ok(reloaded !== undefined)
    assert.equal(reloaded.sheets.length, sheets.length)
    assert.equal(reloaded.profile.sha256, profile.sha256)
  },
)

