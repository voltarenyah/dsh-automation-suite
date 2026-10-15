/**
 * The `engineeringAccess` service: the seam the engineering-context plugin
 * (the engineering-context plugin) consumes.
 *
 * What is asserted is the contract the engineering-context plugin depends on: each method sends the
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
  assert.notEqual(service, undefined, 'apply must register the service the engineering-context plugin looks up')
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

/** A running controller, as the session reader sees it. */
const RUNNING = { state: 'ready', exePath: 'C:\\ctl.exe', exeExists: true, pid: 4242, ready: { openness: { available: true } } }

/** The controller payload for the session's device list. */
function softwareFrame(devices) {
  return frame('ProjectInfo', undefined, {
    data: {
      attributes: { name: 'PEI_SinoARP', path: 'C:\\work\\tia\\PEI_SinoARP\\tia.ap17', isModified: false },
      software: { count: devices.length, items: devices },
    },
  })
}

test('saveProjectAs sends the target directory and surfaces what TIA actually produced', async () => {
  const { service, calls } = serviceWith(() =>
    frame('SaveProject', undefined, {
      data: { savedAs: 'C:\\w\\tia\\Proj\\tia.ap17', requestedSaveAsDir: 'C:\\w\\tia\\Proj', projectPath: 'C:\\w\\tia\\Proj' },
    }),
  )

  const result = await service.saveProjectAs('C:\\w\\tia\\Proj')
  assert.equal(calls[0].operation, 'SaveProject')
  assert.deepEqual(calls[0].params, { save_as_dir: 'C:\\w\\tia\\Proj' })
  assert.equal(result.data.savedAs, 'C:\\w\\tia\\Proj\\tia.ap17')
  assert.equal(result.data.requestedSaveAsDir, 'C:\\w\\tia\\Proj')

  await service.saveProjectAs('C:\\w\\tia\\Proj', { dryRun: true })
  assert.deepEqual(calls[1].params, { save_as_dir: 'C:\\w\\tia\\Proj', dry_run: true })

  await assert.rejects(() => service.saveProjectAs(''), TypeError)
})

test('readTiaSession never starts the controller and reads the open project when it can', async () => {
  // Stopped: no operation may be sent at all.
  const stopped = serviceWith(undefined, { state: 'stopped', exePath: 'C:\\ctl.exe', exeExists: true, pid: null, ready: null })
  const stoppedSession = await stopped.service.readTiaSession()
  assert.equal(stoppedSession.running, false)
  assert.equal(stoppedSession.projectOpen, false)
  assert.match(stoppedSession.reason, /not running/u)
  assert.equal(stopped.calls.length, 0, 'reading the session must not start the controller')

  // Running but nothing open: the controller's project_not_open is a state.
  const empty = serviceWith(
    () => frame('ProjectInfo', undefined, { ok: false, error: { code: 'project_not_open', message: 'no project' } }),
    RUNNING,
  )
  const emptySession = await empty.service.readTiaSession()
  assert.equal(emptySession.running, true)
  assert.equal(emptySession.projectOpen, false)
  assert.match(emptySession.reason, /no project is open/u)

  // Running with a project: name, path, dirty flag and the PLC software list.
  const open = serviceWith(
    () => softwareFrame([{ device: 'S7-1500', software: 'PLC_1', blockCount: 1152 }]),
    RUNNING,
  )
  const session = await open.service.readTiaSession()
  assert.equal(session.projectOpen, true)
  assert.equal(session.projectName, 'PEI_SinoARP')
  assert.equal(session.isModified, false)
  assert.deepEqual(session.software, [{ device: 'S7-1500', software: 'PLC_1', blockCount: 1152 }])
  assert.deepEqual(open.calls[0].params, { sections: ['attributes', 'software'], max_objects: 500 })
})

test('rebuildSource lays one device out by type, and reports every refusal', async () => {
  const devices = [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }]
  const { service } = serviceWith(
    (operation, params) => {
      if (operation === 'ProjectInfo') return softwareFrame(devices)
      const portable = params.output_dir.replace(/\\/gu, '/')
      if (portable.endsWith('/blocks')) {
        return frame('ExportBlocks', params, {
          data: {
            counts: { blocks: 2, types: 0, tagTables: 0 },
            manifest: `${params.output_dir}\\_tia-openness-manifest.json`,
            summary: { exported: 2, skipped: 0, failed: 1, verificationFailed: 0 },
            failures: [{ category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' }],
          },
        })
      }
      return frame('ExportBlocks', params, {
        data: {
          counts: { blocks: 0, types: 3, tagTables: 1 },
          manifest: `${params.output_dir}\\_tia-openness-manifest.json`,
          summary: { exported: 4, skipped: 1, failed: 0, verificationFailed: 0 },
        },
      })
    },
    RUNNING,
  )

  const result = await service.rebuildSource('C:\\w\\source')
  assert.equal(result.ok, true)
  assert.equal(result.devices.length, 1)
  const device = result.devices[0]
  assert.equal(device.directory, 'C:\\w\\source\\S7-1500')
  assert.equal(device.blocks.directory, 'C:\\w\\source\\S7-1500\\blocks')
  assert.equal(device.types.directory, 'C:\\w\\source\\S7-1500\\types')
  assert.equal(device.tagTables.directory, 'C:\\w\\source\\S7-1500\\tag_tables')
  assert.equal(device.blocks.exported, 2)
  assert.equal(device.blocks.failed, 1)
  assert.equal(device.types.exported, 3)
  assert.equal(device.tagTables.exported, 1)
  assert.equal(device.skipped, 1, 'skipped comes from the call summaries and is device-level')
  assert.equal(device.verificationFailed, 0)
  assert.match(device.blocks.manifest, /blocks\\_tia-openness-manifest\.json$/u)
  assert.match(device.types.manifest, /S7-1500\\_tia-openness-manifest\.json$/u)

  // The refusal is attributed to its family and never dropped.
  assert.deepEqual(result.failures, [
    { device: 'S7-1500', category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' },
  ])
})

test('rebuildSource names folders safely and keeps colliding device names apart', async () => {
  const devices = [
    { device: 'S7-1500/2', software: 'PLC_1', blockCount: 0 },
    { device: 'S7-1500_2', software: 'PLC_2', blockCount: 0 },
  ]
  const { service } = serviceWith((operation, params) =>
    operation === 'ProjectInfo'
      ? softwareFrame(devices)
      : frame('ExportBlocks', params, { data: { counts: { blocks: 0, types: 0, tagTables: 0 }, summary: {} } }),
    RUNNING,
  )
  const result = await service.rebuildSource('C:\\w\\source')
  assert.deepEqual(
    result.devices.map((entry) => entry.directory),
    ['C:\\w\\source\\S7-1500_2', 'C:\\w\\source\\S7-1500_2~2'],
  )
})

test('rebuildSource honours a device filter and names the ones it could not find', async () => {
  const devices = [
    { device: 'A', software: 'PLC_A', blockCount: 1 },
    { device: 'B', software: 'PLC_B', blockCount: 1 },
  ]
  const { service, calls } = serviceWith((operation, params) =>
    operation === 'ProjectInfo'
      ? softwareFrame(devices)
      : frame('ExportBlocks', params, { data: { counts: { blocks: 0, types: 0, tagTables: 0 }, summary: {} } }),
    RUNNING,
  )

  const result = await service.rebuildSource('C:\\w\\source', { deviceNames: ['A', 'Nope'] })
  assert.deepEqual(result.devices.map((entry) => entry.device), ['A'])
  assert.deepEqual(result.missingDevices, ['Nope'])
  // Only device A was exported: two calls, both naming it.
  const exports = calls.filter((call) => call.operation === 'ExportBlocks')
  assert.equal(exports.length, 2)
  for (const call of exports) {
    assert.equal(call.params.device_name, 'A')
    assert.equal(call.params.software_name, 'PLC_A')
    assert.equal(call.params.write_manifest, true)
    assert.equal(call.params.overwrite, false)
    assert.equal(call.params.dry_run, false)
  }
  assert.deepEqual(exports[0].params.categories, ['blocks'])
  assert.deepEqual(exports[1].params.categories, ['types', 'tag_tables'])
})

test('rebuildSource reports a missing controller or project instead of exporting nothing quietly', async () => {
  const stopped = serviceWith(undefined, { state: 'stopped', exePath: 'x', exeExists: true, pid: null, ready: null })
  const noController = await stopped.service.rebuildSource('C:\\w\\source')
  assert.equal(noController.ok, false)
  assert.equal(noController.error.code, 'controller_not_running')
  assert.equal(stopped.calls.length, 0, 'a stopped controller must not be started to find this out')

  const noProject = serviceWith(
    () => frame('ProjectInfo', undefined, { ok: false, error: { code: 'project_not_open', message: 'no project' } }),
    RUNNING,
  )
  const nothingOpen = await noProject.service.rebuildSource('C:\\w\\source')
  assert.equal(nothingOpen.ok, false)
  assert.equal(nothingOpen.error.code, 'project_not_open')
  assert.equal(
    noProject.calls.some((call) => call.operation === 'ExportBlocks'),
    false,
    'no export may be attempted without a project',
  )
})


