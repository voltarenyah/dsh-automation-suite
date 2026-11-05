/**
 * The project-texts XLSX reader/writer.
 *
 * The fixture mirrors the real TIA export shape: system columns, a source
 * header ending in `*`, a target column, and `ref=` columns. The merge test
 * asserts the properties the workflow depends on:
 *
 *   - only selected rows survive (untouched rows must not be blanked);
 *   - a comment that starts with `=` stays a string, never a formula.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as XLSX from '@e965/xlsx'

const { readTextWorkbook, mergeTextWorkbook } = await import(
  `../lib/project-text/xlsx.js?t=${Date.now()}${Math.random()}`
)

const HEADER = [
  'Category',
  'ViewPath',
  'Internal ID',
  'Substitutions',
  'en-GB*',
  'zh-CN',
  'ref="0"',
  'ref="1"',
]

function fixture(dir) {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    HEADER,
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\FB_Motor\\Block title', 'id-1', '', 'Start motor', '', '', ''],
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\FB_Motor\\Network 1\\Comment', 'id-2', '', 'Keep this', '保留原文', '', ''],
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\FB_Motor\\Network 2\\Comment', 'id-3', '', '= 1 => active', '', '', ''],
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, 'User Texts')
  const file = join(dir, 'texts.xlsx')
  writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  return file
}

test('reads the real export shape and finds both language columns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ptext-'))
  try {
    const file = fixture(dir)
    const parsed = await readTextWorkbook(file, 'en-GB', 'zh-CN')
    assert.equal(parsed.sheetName, 'User Texts')
    assert.equal(parsed.rows.length, 3)
    assert.equal(parsed.rows[0].source, 'Start motor')
    assert.equal(parsed.rows[0].internalId, 'id-1')
    assert.equal(parsed.rows[1].target, '保留原文')
    assert.match(parsed.rows[2].source, /^= 1 => active$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merge keeps only selected rows, writes the target, and keeps = as text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ptext-'))
  try {
    const file = fixture(dir)
    const output = join(dir, 'translated.xlsx')
    const result = await mergeTextWorkbook(file, output, 'en-GB', 'zh-CN', new Map([[2, '启动电机'], [4, '= 1 => 激活']]))
    assert.equal(result.rows, 3)
    assert.equal(result.translated, 2)
    assert.equal(result.preserved, 1)
    assert.equal(existsSync(output), true)

    const workbook = XLSX.read(readFileSync(output), { type: 'buffer' })
    const sheet = workbook.Sheets['User Texts']
    const table = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
    assert.equal(table.length, 3, 'header + two translated rows; the excluded row is removed')
    assert.equal(table[1][4], 'Start motor')
    assert.equal(table[1][5], '启动电机')
    assert.equal(table[2][5], '= 1 => 激活')
    assert.equal(JSON.stringify(table).includes('保留原文'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
