/**
 * `project_translate(plan)` smoke test with fake TIA services.
 *
 * It exercises the real tool body, the XLSX reader and the filter pipeline,
 * without TIA: `projectTextAccess` copies a fixture workbook, `engineeringAccess`
 * returns an empty fingerprint list, and `listBlocks` reports one F block so the
 * `programmingLanguage=F_*` exclusion is asserted.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as XLSX from '@e965/xlsx'

import {
  createTestContext,
  executeTool,
  fakeExec,
} from './helpers/harness.mjs'

const { toolDefinitions } = await import(`../lib/tools/index.js?t=${Date.now()}${Math.random()}`)
const { resolveConfig } = await import(`../lib/config.js?t=${Date.now()}${Math.random()}`)

async function fixture(file) {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Category', 'ViewPath', 'Internal ID', 'Substitutions', 'en-GB*', 'zh-CN', 'ref="0"'],
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\FB_Motor\\Block title', 'id-title', '', 'Start motor', '', ''],
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\F_Block\\Block comment', 'id-fblock', '', 'Safety text', '', ''],
    ['<BlockCommentCategoryData>', 'PLC\\Program blocks\\FB_Motor\\Network 1\\Comment', 'id-have', '', 'Keep this', '保留原文', ''],
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, 'User Texts')
  writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

function fakeServices(fixtureFile) {
  const projectTextAccess = {
    async readLanguages() {
      return {
        ok: true,
        data: {
          activeLanguages: [{ culture: 'en-GB' }, { culture: 'zh-CN' }],
          referenceLanguage: 'en-GB',
          editingLanguage: 'en-GB',
        },
      }
    },
    async listBlocks() {
      return {
        ok: true,
        data: {
          blocks: {
            items: [
              { name: 'FB_Motor', attributes: [{ name: 'ProgrammingLanguage', value: 'LAD' }] },
              { name: 'F_Block', attributes: [{ name: 'ProgrammingLanguage', value: 'F_LAD' }] },
            ],
          },
        },
      }
    },
    async exportTexts(file) {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(fixtureFile, file)
      return { ok: true, data: { file } }
    },
    async importTexts() { return { ok: true, data: { state: 'Info' } } },
    async setLanguages() { return { ok: true, data: {} } },
    async archiveProject() { return { ok: true, data: {} } },
    async saveProject() { return { ok: true, data: {} } },
  }
  const engineeringAccess = {
    async listObjects() { return { objects: [] } },
  }
  return { projectTextAccess, engineeringAccess }
}

test('plan filters by scope, excludes F blocks, and writes jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ptext-plan-'))
  try {
    const fixtureFile = join(dir, 'export.xlsx')
    await fixture(fixtureFile)
    const { ctx } = createTestContext({ services: fakeServices(fixtureFile) })
    const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
    const tool = definitions.find((definition) => definition.name === 'project_translate')
    assert.notEqual(tool, undefined)

    const outcome = await executeTool(
      tool,
      { action: 'plan', target_language: 'zh-CN', source_languages: ['en-GB'], scope: 'plc-comments' },
      fakeExec(dir),
    )
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
    assert.equal(outcome.data.counts.selected, 1)
    assert.equal(outcome.data.counts.unique, 1)
    assert.equal(outcome.data.counts.fBlocks, 1)

    const selected = readFileSync(outcome.data.artifacts.selected, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    assert.equal(selected.length, 1)
    assert.equal(selected[0].source, 'Start motor')
    assert.equal(selected[0].text_type, 'block_title')
    assert.equal(selected[0].source_language, 'en-GB')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply merges the translation, imports, and reports state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ptext-apply-'))
  try {
    const fixtureFile = join(dir, 'export.xlsx')
    await fixture(fixtureFile)
    const { ctx } = createTestContext({ services: fakeServices(fixtureFile) })
    const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
    const tool = definitions.find((definition) => definition.name === 'project_translate')
    const plan = await executeTool(
      tool,
      { action: 'plan', target_language: 'zh-CN', source_languages: ['en-GB'], scope: 'plc-comments' },
      fakeExec(dir),
    )
    assert.equal(plan.ok, true, JSON.stringify(plan.error))
    const selected = readFileSync(plan.data.artifacts.selected, 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    const translationsFile = join(dir, 'translations.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(translationsFile, JSON.stringify({ text_id: selected[0].text_id, target: '启动电机' }) + '\n')

    const outcome = await executeTool(
      tool,
      {
        action: 'apply',
        target_language: 'zh-CN',
        plan_file: plan.data.artifacts.plan,
        translations_file: translationsFile,
        archive: true,
      },
      fakeExec(dir),
    )
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
    assert.equal(outcome.data.state, 'Info')
    assert.equal(outcome.data.merged.translated, 1)
    assert.equal(outcome.data.codeChanged, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
