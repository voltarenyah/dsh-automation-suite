/**
 * `projectTextAccess`: the write seam for the translation workflow.
 *
 * The contract is intentionally narrow: each method sends the same controller
 * operation/parameters as the model-facing tool, returns the tool envelope, and
 * leaves permission/rollback policy to the engineering-context workflow.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createTestContext,
  loadPlugin,
} from './helpers/harness.mjs'

const { PROJECT_TEXT_ACCESS_SERVICE, ProjectTextAccess } = await import(
  `../lib/project-text-access.js?t=${Date.now()}${Math.random()}`
)

const LOG = { debug() {}, info() {}, warn() {}, error() {} }

function result(operation, params) {
  return {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: true,
    dryRun: false,
    durationMs: 5,
    data: { operation, params },
    changes: [],
    diagnostics: [],
  }
}

function serviceWith() {
  const calls = []
  const dependencies = {
    request: async (operation, params, options) => {
      calls.push({
        operation,
        params,
        options: options && Object.keys(options).length > 0 ? options : undefined,
      })
      return result(operation, params)
    },
    status: () => ({ state: 'stopped', exePath: 'C:\\ctl.exe', exeExists: true, ready: null }),
    verbose: false,
    log: LOG,
  }
  const harness = createTestContext()
  return { service: new ProjectTextAccess(harness.ctx, dependencies), calls, harness }
}

test('apply exposes projectTextAccess and unloading removes it', async () => {
  const plugin = await loadPlugin()
  const harness = createTestContext()
  plugin.apply(harness.ctx, {})
  const service = harness.ctx.get(PROJECT_TEXT_ACCESS_SERVICE)
  assert.notEqual(service, undefined)
  for (const method of [
    'exportTexts',
    'importTexts',
    'readLanguages',
    'setLanguages',
    'archiveProject',
    'saveProject',
  ]) {
    assert.equal(typeof service[method], 'function', `${method} must be callable`)
  }
  await harness.unload()
  assert.equal(harness.ctx.get(PROJECT_TEXT_ACCESS_SERVICE), undefined)
})

test('exportTexts sends ProjectTexts export with source and target', async () => {
  const { service, calls } = serviceWith()
  const outcome = await service.exportTexts('C:\\out\\texts.xlsx', 'en-GB', 'zh-CN')
  assert.equal(outcome.ok, true)
  assert.deepEqual(calls[0], {
    operation: 'ProjectTexts',
    params: {
      action: 'export',
      file: 'C:\\out\\texts.xlsx',
      source_language: 'en-GB',
      target_language: 'zh-CN',
    },
    options: undefined,
  })
})

test('importTexts sends update_source_language=false by default', async () => {
  const { service, calls } = serviceWith()
  await service.importTexts('C:\\out\\texts.xlsx')
  assert.equal(calls[0].operation, 'ProjectTexts')
  assert.deepEqual(calls[0].params, {
    action: 'import',
    file: 'C:\\out\\texts.xlsx',
    update_source_language: false,
  })
})

test('readLanguages and setLanguages map to ProjectLanguages', async () => {
  const { service, calls } = serviceWith()
  await service.readLanguages()
  assert.deepEqual(calls[0], {
    operation: 'ProjectLanguages',
    params: { action: 'list' },
    options: undefined,
  })

  await service.setLanguages({
    activeLanguages: ['zh-CN'],
    activeMode: 'add',
    editingLanguage: 'en-GB',
    referenceLanguage: 'en-GB',
  })
  assert.deepEqual(calls[1].params, {
    action: 'set',
    active_languages: ['zh-CN'],
    active_mode: 'add',
    editing_language: 'en-GB',
    reference_language: 'en-GB',
  })
})

test('archiveProject and saveProject map to ArchiveProject/SaveProject', async () => {
  const { service, calls } = serviceWith()
  await service.archiveProject({ targetDir: 'C:\\arc', targetName: 'before' })
  assert.deepEqual(calls[0], {
    operation: 'ArchiveProject',
    params: {
      action: 'archive',
      target_dir: 'C:\\arc',
      target_name: 'before',
      mode: 'compressed',
    },
    options: undefined,
  })

  await service.saveProject()
  assert.deepEqual(calls[1], { operation: 'SaveProject', params: {}, options: undefined })

  await service.saveProject({ saveAsDir: 'C:\\copy' })
  assert.deepEqual(calls[2].params, { save_as_dir: 'C:\\copy' })
})


test('listBlocks asks for attributes so F blocks can be identified', async () => {
  const { service, calls } = serviceWith()
  await service.listBlocks({ maxItems: 50 })
  assert.equal(calls[0].operation, 'ListPlcObjects')
  assert.deepEqual(calls[0].params, {
    categories: ['blocks'],
    include_attributes: true,
    include_fingerprints: false,
    max_items: 50,
  })
})
