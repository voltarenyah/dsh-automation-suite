/**
 * The `engineeringAccess` service: the seam the engineering-context plugin
 * (family 2) consumes.
 *
 * What is asserted is the contract family 2 depends on: each method sends the
 * same controller operation and parameters as the matching model-facing tool,
 * the per-family envelopes are flattened into one row list, a truncated answer
 * says so instead of looking complete, `closeProject` cannot be called without
 * stating its intent, and failures keep the tools' convention — operation-level
 * failures come back as data, transport failures are thrown.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestContext, loadAccessModule, loadPlugin } from './helpers/harness.mjs'

const { DEFAULT_LIST_MAX_ITEMS, ENGINEERING_ACCESS_SERVICE, EngineeringAccess } = await loadAccessModule()

const LOG = { debug() {}, info() {}, warn() {}, error() {} }

function frame(operation, params, overrides = {}) {
  return {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: true,
    dryRun: params !== undefined && params.dry_run === true,
    durationMs: 7,
    data: {},
    changes: [],
    diagnostics: [],
    ...overrides,
  }
}

/** A recording dependency plus the status snapshot the service should report. */
function recording(reply, statusSnapshot) {
  const calls = []
  const dependencies = {
    request: async (operation, params, options) => {
      calls.push({ operation, params, options })
      return reply === undefined ? frame(operation, params) : reply(operation, params)
    },
    status: () => statusSnapshot ?? { state: 'stopped', exePath: 'C:\\ctl.exe', exeExists: true, ready: null },
    verbose: false,
    log: LOG,
  }
  return { calls, dependencies }
}

function serviceWith(reply, statusSnapshot) {
  const harness = createTestContext()
  const { calls, dependencies } = recording(reply, statusSnapshot)
  const service = new EngineeringAccess(harness.ctx, dependencies)
  return { service, calls, harness }
}

/** The canned listing the flattening tests read, deliberately irregular. */
function listFrame() {
  return frame('ListPlcObjects', undefined, {
    durationMs: 3,
    data: {
      counts: { blocks: 3, types: 1, tagTables: 0 },
      truncated: false,
      blocks: {
        count: 3,
        truncated: true,
        items: [
          {
            name: 'FB_Motor',
            group: '010_Cell',
            fingerprints: [
              { id: 'Code', value: 'aaa' },
              { id: 'Comments', error: 'the block is not consistent' },
            ],
          },
          { name: 'FC_Test' },
        ],
      },
      types: { count: 1, truncated: false, items: [{ name: 'MyUDT', group: 'Lib' }] },
      missing: { blocks: ['Nope'] },
    },
  })
}

test('apply exposes engineeringAccess, and unloading takes it away', async () => {
  const plugin = await loadPlugin()
  const harness = createTestContext()

  plugin.apply(harness.ctx, {})
  const service = harness.ctx.get(ENGINEERING_ACCESS_SERVICE)
  assert.notEqual(service, undefined, 'apply must register the service family 2 looks up')
  for (const method of ['status', 'openProject', 'closeProject', 'listObjects', 'exportObjects']) {
    assert.equal(typeof service[method], 'function', `${method} must be callable`)
  }
  assert.equal(harness.ctx.engineeringAccess, service)

  await harness.unload()
  assert.equal(harness.ctx.get(ENGINEERING_ACCESS_SERVICE), undefined, 'unloading must unregister the service')
  assert.equal(harness.ctx.engineeringAccess, undefined)
})

test('openProject sends the same operation and parameters the tool does', async () => {
  const { service, calls } = serviceWith()

  const plain = await service.openProject('C:\\p\\Line1.ap17')
  assert.equal(plain.ok, true)
  assert.equal(calls[0].operation, 'OpenProject')
  assert.deepEqual(calls[0].params, { project_path: 'C:\\p\\Line1.ap17' })
  // allow_upgrade stays absent unless asked for: it is the one irreversible write.
  assert.equal('allow_upgrade' in calls[0].params, false)

  await service.openProject('C:\\p\\Line1.ap17', { allowUpgrade: true, withWindow: false, dryRun: true })
  assert.deepEqual(calls[1].params, {
    project_path: 'C:\\p\\Line1.ap17',
    with_window: false,
    allow_upgrade: true,
    dry_run: true,
  })

  await assert.rejects(() => service.openProject(''), TypeError)
})

test('closeProject refuses to guess and otherwise mirrors the tool', async () => {
  const { service, calls } = serviceWith()

  await assert.rejects(() => service.closeProject(), TypeError)
  await assert.rejects(() => service.closeProject({}), TypeError)

  await service.closeProject({ dryRun: false, save: true })
  assert.equal(calls[0].operation, 'CloseProject')
  assert.deepEqual(calls[0].params, { save: true, close_portal: false, dry_run: false })

  await service.closeProject({ dryRun: true })
  assert.deepEqual(calls[1].params, { save: false, close_portal: false, dry_run: true })
})

test('listObjects raises the cap, flattens the families and reports truncation', async () => {
  const { service, calls } = serviceWith(() => listFrame())
  const result = await service.listObjects({ includeFingerprints: true })

  assert.equal(calls[0].operation, 'ListPlcObjects')
  assert.equal(calls[0].params.max_items, DEFAULT_LIST_MAX_ITEMS)
  assert.equal(calls[0].params.include_fingerprints, true)
  assert.equal(calls[0].params.recursive, true)
  assert.equal(calls[0].params.include_attributes, false)
  // No family was named, so none is forced: the controller then lists exactly the
  // families the request selects.
  assert.equal('categories' in calls[0].params, false)

  assert.equal(result.objects.length, 3)
  assert.deepEqual(
    result.objects.map((object) => [object.category, object.name, object.group]),
    [
      ['blocks', 'FB_Motor', '010_Cell'],
      ['blocks', 'FC_Test', null],
      ['types', 'MyUDT', 'Lib'],
    ],
  )
  assert.deepEqual(result.objects[0].fingerprints, [
    { id: 'Code', value: 'aaa', error: null },
    { id: 'Comments', value: null, error: 'the block is not consistent' },
  ])
  assert.equal(result.objects[1].fingerprints, null, 'an object without fingerprints reports null, not []')

  assert.deepEqual(result.families, {
    blocks: { count: 3, returned: 2, truncated: true },
    types: { count: 1, returned: 1, truncated: false },
  })
  assert.equal(result.truncated, true, 'a family that was cut short must make the whole answer say so')
  assert.deepEqual(result.missing, { blocks: ['Nope'] })
})

test('listObjects passes names and filters through, and honours an explicit cap', async () => {
  const { service, calls } = serviceWith(() => listFrame())
  await service.listObjects({
    blockNames: ['FB_Motor'],
    typeNames: ['MyUDT'],
    nameFilter: 'motor',
    deviceName: 'Sino_PEI',
    softwareName: 'Sino_PEI',
    maxItems: 50,
    recursive: false,
    includeTags: true,
  })

  assert.deepEqual(calls[0].params, {
    recursive: false,
    include_tags: true,
    include_constants: false,
    include_attributes: false,
    include_fingerprints: false,
    max_items: 50,
    name_filter: 'motor',
    device_name: 'Sino_PEI',
    software_name: 'Sino_PEI',
    block_names: ['FB_Motor'],
    type_names: ['MyUDT'],
  })
})

test('listObjects reads truncation from the top level as well', async () => {
  const { service } = serviceWith(
    () => frame('ListPlcObjects', undefined, { data: { truncated: true, blocks: { count: 1, items: [], truncated: false } } }),
  )
  const result = await service.listObjects()
  assert.equal(result.truncated, true)
  assert.deepEqual(result.objects, [])
})

test('exportObjects mirrors the tool defaults and writes nothing else', async () => {
  const { service, calls } = serviceWith()

  await service.exportObjects({ outputDir: 'C:\\out', blockNames: ['FB_Motor'] })
  assert.equal(calls[0].operation, 'ExportBlocks')
  assert.deepEqual(calls[0].params, {
    output_dir: 'C:\\out',
    categories: ['blocks'],
    recursive: true,
    overwrite: false,
    export_options: 'with_defaults',
    write_manifest: true,
    dry_run: false,
    block_names: ['FB_Motor'],
  })

  await service.exportObjects({
    outputDir: 'C:\\out',
    categories: ['blocks', 'types', 'tag_tables'],
    overwrite: true,
    exportOptions: 'none',
    writeManifest: false,
    dryRun: true,
    deviceName: 'd',
    softwareName: 's',
  })
  assert.deepEqual(calls[1].params, {
    output_dir: 'C:\\out',
    categories: ['blocks', 'types', 'tag_tables'],
    recursive: true,
    overwrite: true,
    export_options: 'none',
    write_manifest: false,
    dry_run: true,
    device_name: 'd',
    software_name: 's',
  })

  await assert.rejects(() => service.exportObjects({}), TypeError)
})

test('status distinguishes missing, unprobed and unavailable Openness', () => {
  const missing = serviceWith(undefined, { state: 'stopped', exePath: 'C:\\nope.exe', exeExists: false, ready: null })
  const missingStatus = missing.service.status()
  assert.equal(missingStatus.available, false)
  assert.match(missingStatus.reason, /executable is missing/u)
  assert.equal(missingStatus.probed, false)

  const unprobed = serviceWith(undefined, { state: 'stopped', exePath: 'C:\\ctl.exe', exeExists: true, ready: null })
  const unprobedStatus = unprobed.service.status()
  assert.equal(unprobedStatus.available, true, 'a not-yet-probed controller is worth trying: the call starts it')
  assert.equal(unprobedStatus.probed, false)
  assert.match(unprobedStatus.reason, /has not been started yet/u)

  const unavailable = serviceWith(undefined, {
    state: 'stopped',
    exePath: 'C:\\ctl.exe',
    exeExists: true,
    ready: { openness: { available: false, message: 'the DLL is missing' } },
  })
  const unavailableStatus = unavailable.service.status()
  assert.equal(unavailableStatus.available, false)
  assert.equal(unavailableStatus.reason, 'the DLL is missing')
  assert.equal(unavailableStatus.probed, true)

  const okService = serviceWith(undefined, {
    state: 'ready',
    exePath: 'C:\\ctl.exe',
    exeExists: true,
    ready: { openness: { available: true } },
  })
  const okStatus = okService.service.status()
  assert.equal(okStatus.available, true)
  assert.equal(okStatus.reason, null)
  assert.equal(okStatus.probed, true)
})

test('operation failures come back as data; transport failures are thrown', async () => {
  const failed = serviceWith(() =>
    frame('ListPlcObjects', undefined, {
      ok: false,
      error: { code: 'project_not_open', message: 'no project is open', details: { hint: 'open it first' } },
    }),
  )
  const result = await failed.service.listObjects()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'project_not_open')
  assert.equal(result.error.message, 'no project is open')
  assert.deepEqual(result.error.details, { hint: 'open it first' })
  // The rows are simply empty; a caller must look at `ok`, not at the list.
  assert.deepEqual(result.objects, [])

  const broken = serviceWith(() => {
    throw new Error('controller_not_found: the controller executable is missing')
  })
  await assert.rejects(() => broken.service.listObjects(), /controller_not_found/u)
  await assert.rejects(() => broken.service.openProject('C:\\p\\x.ap17'), /controller_not_found/u)
})
