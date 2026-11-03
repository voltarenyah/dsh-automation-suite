/**
 * Pure rules: placement math and the SEE conventions.
 *
 * The numbers in the first test are not invented — they are the transform pdf.js
 * reports for the `MICHELIN` run on sheet 210 and the char box PDFium reports for
 * the same glyph, which is how the 90-degree mapping was verified on the real
 * drawing set.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classify,
  classifyEntity,
  groupCabinets,
  isOddPage,
  parseXrefs,
  placeItem,
  readTitleBlock,
} from '../lib/indexer/rules.js'

test('placeItem maps a +90 run onto the display frame', () => {
  const run = placeItem(
    { str: 'MICHELIN', width: 52.0038, height: 12, transform: [0, 10.0308, -12, 0, 567.3598, 338.5109] },
    { width: 842, height: 595, rotation: 90 },
  )
  // Display x runs along the unrotated y axis, display y along the unrotated x.
  assert.ok(Math.abs(run.x - 338.5) < 0.2, `x ${run.x}`)
  assert.ok(Math.abs(run.y - 555.4) < 0.2, `y ${run.y}`)
  assert.ok(Math.abs(run.w - 52.0) < 0.2, `w ${run.w}`)
  assert.ok(Math.abs(run.h - 12.0) < 0.2, `h ${run.h}`)
  assert.ok(Math.abs(run.size - 12) < 0.1)
})

test('placeItem keeps an unrotated page upright', () => {
  const run = placeItem(
    { str: 'A', width: 10, height: 10, transform: [1, 0, 0, 1, 100, 700] },
    { width: 595, height: 842, rotation: 0 },
  )
  assert.equal(run.x, 100)
  assert.equal(run.y, 842 - 710)
})

test('isOddPage flags only the portrait connector sheets', () => {
  assert.equal(isOddPage({ width: 595, height: 842, rotation: 180 }), true)
  assert.equal(isOddPage({ width: 842, height: 595, rotation: 90 }), false)
})

test('readTitleBlock reads sheet number, title, locality and the prev/next pair', () => {
  const block = readTitleBlock([
    { text: 'SHEET', x: 781.7, y: 528.1, w: 17.7, h: 4.4, size: 4.4, angle: 0 },
    { text: '210', x: 781.8, y: 539.5, w: 15, h: 8.8, size: 8.8, angle: 0 },
    { text: 'AG : 8 SAFETY LOGICAL INPUTS', x: 474.2, y: 540.5, w: 128, h: 8, size: 8, angle: 0 },
    { text: 'MAIN CABINET', x: 501.7, y: 530.5, w: 60, h: 9, size: 9, angle: 0 },
    { text: 'LOCALISATION  : AG', x: 40.3, y: 76.5, w: 80, h: 8, size: 8, angle: 0 },
    { text: '201', x: 769, y: 556, w: 12, h: 5.9, size: 5.9, angle: 0 },
    { text: '211', x: 797, y: 556, w: 12, h: 5.9, size: 5.9, angle: 0 },
  ])
  assert.equal(block.sheet, 210)
  assert.equal(block.title, 'AG : 8 SAFETY LOGICAL INPUTS')
  assert.equal(block.loc, 'AG')
  assert.equal(block.prev, 201)
  assert.equal(block.next, 211)
})

test('readTitleBlock returns nulls on a cover sheet', () => {
  const block = readTitleBlock([{ text: 'MAIN PAGE', x: 500, y: 540, w: 40, h: 8, size: 8, angle: 0 }])
  assert.equal(block.sheet, null)
  assert.equal(block.title, 'MAIN PAGE')
})

test('classify recognises the ten templates', () => {
  assert.equal(classify('MAIN PAGE'), 'main')
  assert.equal(classify('REVISIONS'), 'revision')
  assert.equal(classify('SUMMARY'), 'summary')
  assert.equal(classify('MACHINE GROUND'), 'ground')
  assert.equal(classify('CONNECTORS - MARKING EXEMPLES'), 'marking')
  assert.equal(classify('LAYOUT AG'), 'layout')
  assert.equal(classify('SYNOPTIC'), 'synoptic')
  assert.equal(classify('TERMINAL : X2A & X2B'), 'terminal')
  assert.equal(classify('CONNECTOR: XSPSE'), 'connector')
  assert.equal(classify('Cable : W021,W025'), 'cable')
  assert.equal(classify('POWER SUPPLY BOX'), 'power')
  assert.equal(classify('AG : 8 SAFETY LOGICAL INPUTS'), 'schematic')
  assert.equal(classify(null), 'schematic')
})

test('parseXrefs keeps sheet references and drops contact designations', () => {
  const sheets = new Set([100, 110, 115, 116, 210, 220, 251, 1100])
  const found = parseXrefs('(220-14) 13-14 NO/ 251-22 (116-13) A(1100-8)', (n) => sheets.has(n))
  const keys = found.map((entry) => `${entry.side ?? ''}${entry.target}-${entry.column}`)
  assert.ok(keys.includes('220-14'))
  assert.ok(keys.includes('251-22'))
  assert.ok(keys.includes('116-13'))
  assert.ok(keys.includes('A1100-8'))
  assert.equal(
    found.some((entry) => entry.target === 13),
    false,
    'a contact designation must not become a reference',
  )
  // A target outside the sheet inventory is never a reference.
  assert.equal(found.some((entry) => entry.target === 999), false)
})

test('classifyEntity distinguishes the five kinds', () => {
  assert.equal(classifyEntity('220KA3'), 'tag')
  assert.equal(classifyEntity('210.VS4'), 'wire')
  assert.equal(classifyEntity('W015'), 'cable')
  assert.equal(classifyEntity('%I400.3'), 'address')
  assert.equal(classifyEntity('X3.FT'), 'terminal')
  assert.equal(classifyEntity('P4 CONTACTORS FEEDBACK'), null)
})

test('groupCabinets splits on cover sheets and names by locality', () => {
  const cabinets = groupCabinets([
    { page: 1, sheet: null, loc: null },
    { page: 2, sheet: 2, loc: null },
    { page: 3, sheet: 100, loc: 'AG' },
    { page: 4, sheet: 101, loc: 'AG' },
    { page: 5, sheet: null, loc: null },
    { page: 6, sheet: 100, loc: 'COF-BASE-A' },
  ])
  assert.equal(cabinets.length, 2)
  assert.deepEqual(cabinets[0], { id: 1, name: 'AG', pages: [1, 4], sheets: 3 })
  assert.deepEqual(cabinets[1], { id: 2, name: 'COF-BASE-A', pages: [5, 6], sheets: 1 })
})
