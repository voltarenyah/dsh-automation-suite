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

import { createTestContext, loadAccessModule, loadPlugin, loadRuntimeModule } from './helpers/harness.mjs'

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
  for (const method of ['status', 'openProject', 'closeProject', 'listObjects', 'exportObjects', 'readPlcChecksum', 'syncScan']) {
    assert.equal(typeof service[method], 'function', `${method} must be callable`)
  }
  assert.equal(harness.ctx.engineeringAccess, service)

  await harness.unload()
  assert.equal(harness.ctx.get(ENGINEERING_ACCESS_SERVICE), undefined, 'unloading must unregister the service')
  assert.equal(harness.ctx.engineeringAccess, undefined)
})

test('the host row publishes the internal tiaOpennessRuntime seam, and unloading removes it', async () => {
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()
  const plugin = await loadPlugin()
  const harness = createTestContext()

  // A path that cannot exist keeps this test free of a subprocess.
  plugin.apply(harness.ctx, { controllerPath: 'C:\\does\\not\\exist\\controller.exe' })

  const runtime = harness.ctx.get(TIA_RUNTIME_SERVICE)
  assert.notEqual(runtime, undefined, 'the /tools row reads this seam back by name')
  assert.equal(harness.ctx[TIA_RUNTIME_SERVICE], runtime, 'a service is also a context property')
  // Exactly the tool seam, nothing more: it must not become a second public API.
  assert.equal(typeof runtime.request, 'function')
  assert.equal(typeof runtime.status, 'function')
  assert.equal(runtime.verbose, false, 'verbose mirrors the host row config')
  assert.equal(runtime.status().exeExists, false)
  assert.equal(runtime.openProject, undefined, 'the public API stays on engineeringAccess')

  await harness.unload()
  assert.equal(harness.ctx.get(TIA_RUNTIME_SERVICE), undefined, 'unloading must unregister the seam')
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
    block_names: ['FB_Motor'],
  })

  await service.exportObjects({
    outputDir: 'C:\\out',
    categories: ['blocks', 'types', 'tag_tables'],
    overwrite: true,
    exportOptions: 'none',
    writeManifest: false,
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
    device_name: 'd',
    software_name: 's',
  })

  await assert.rejects(() => service.exportObjects({}), TypeError)
})

test('readPlcChecksum sends PlcChecksum and reports the checksum', async () => {
  const { service, calls } = serviceWith((operation, params) =>
    frame(operation, params, { data: { device: 'PLC_1', software: 'PLC_1', checksum: 'CHK-1' } }),
  )

  const result = await service.readPlcChecksum({ deviceName: 'PLC_1' })

  assert.equal(result.ok, true)
  assert.equal(result.checksum, 'CHK-1')
  assert.equal(result.device, 'PLC_1')
  assert.equal(result.software, 'PLC_1')
  assert.equal(calls[0].operation, 'PlcChecksum')
  assert.deepEqual(calls[0].params, { device_name: 'PLC_1' })
})

test('readPlcChecksum keeps checksum_unavailable as data, not as a thrown failure', async () => {
  const { service } = serviceWith((operation, params) =>
    frame(operation, params, {
      ok: false,
      data: null,
      error: { code: 'checksum_unavailable', message: 'compile the PLC first' },
    }),
  )

  const result = await service.readPlcChecksum()

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checksum_unavailable')
  assert.equal(result.checksum, null)
})

test('syncScan sends the three paths and normalizes the evidence summary', async () => {
  const payload = {
    device: 'PLC_1',
    software: 'PLC_1',
    checksum: 'CHK-1',
    unchanged: false,
    counts: { blocks: 3, types: 1, tagTables: 2, changed: 1, added: 0, removed: 1, unexportable: 1 },
    changed: [{ key: 'blocks|G|FB_Motor', category: 'blocks', name: 'FB_Motor', group: 'G', faces: ['Code', 'Comments'] }],
    added: [],
    removed: [{ key: 'blocks||FB_Old', category: 'blocks', name: 'FB_Old', group: null }],
    unexportable: [{ key: 'blocks||OB_ProDiag', category: 'blocks', name: 'OB_ProDiag', group: null, reason: 'refused' }],
    stage: {
      root: 'C:\\stage',
      evidence: 'C:\\stage\\_evidence.json',
      manifest: 'C:\\stage\\_manifest.json',
      files: 1,
    },
    manifestRebuilt: true,
    stateId: 'sha256:abcdef',
  }
  const { service, calls } = serviceWith((operation, params) => frame(operation, params, { data: payload }))

  const result = await service.syncScan({
    sourceRoot: 'C:\\source',
    stageDir: 'C:\\stage',
    evidencePath: 'C:\\source\\PLC_1\\_evidence.json',
    manifestPath: 'C:\\source\\PLC_1\\_manifest.json',
  })

  assert.equal(calls[0].operation, 'SyncScan')
  assert.deepEqual(calls[0].params, {
    source_root: 'C:\\source',
    stage_dir: 'C:\\stage',
    evidence_path: 'C:\\source\\PLC_1\\_evidence.json',
    manifest_path: 'C:\\source\\PLC_1\\_manifest.json',
    export_options: 'with_defaults',
  })
  assert.equal(result.ok, true)
  assert.equal(result.checksum, 'CHK-1')
  assert.equal(result.unchanged, false)
  assert.deepEqual(result.counts, {
    blocks: 3,
    types: 1,
    tagTables: 2,
    changed: 1,
    added: 0,
    removed: 1,
    unexportable: 1,
  })
  assert.deepEqual(result.changed, [
    { key: 'blocks|G|FB_Motor', category: 'blocks', name: 'FB_Motor', group: 'G', faces: ['Code', 'Comments'] },
  ])
  assert.deepEqual(result.removed, [{ key: 'blocks||FB_Old', category: 'blocks', name: 'FB_Old', group: null }])
  assert.equal(result.unexportable[0].reason, 'refused')
  assert.deepEqual(result.stage, {
    root: 'C:\\stage',
    evidence: 'C:\\stage\\_evidence.json',
    manifest: 'C:\\stage\\_manifest.json',
    files: 1,
  })
  assert.equal(result.manifestRebuilt, true)
  assert.equal(result.stateId, 'sha256:abcdef')
})

test('syncScan defaults to zero counts on an empty envelope and rejects missing paths', async () => {
  const { service } = serviceWith((operation, params) =>
    frame(operation, params, { data: { unchanged: true, stage: null } }),
  )

  const result = await service.syncScan({
    sourceRoot: 'C:\\source',
    stageDir: 'C:\\stage',
    evidencePath: 'C:\\source\\_evidence.json',
  })
  assert.equal(result.unchanged, true)
  assert.equal(result.stage, null)
  assert.deepEqual(result.counts, {
    blocks: 0,
    types: 0,
    tagTables: 0,
    changed: 0,
    added: 0,
    removed: 0,
    unexportable: 0,
  })

  await assert.rejects(() => service.syncScan({ sourceRoot: '', stageDir: 'C:\\s', evidencePath: 'C:\\e' }), TypeError)
  await assert.rejects(() => service.syncScan({ sourceRoot: 'C:\\s', stageDir: '', evidencePath: 'C:\\e' }), TypeError)
  await assert.rejects(() => service.syncScan({ sourceRoot: 'C:\\s', stageDir: 'C:\\t', evidencePath: '' }), TypeError)
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

  await service.saveProjectAs('C:\\w\\tia\\Proj')
  assert.deepEqual(calls[1].params, { save_as_dir: 'C:\\w\\tia\\Proj' })

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

test('rebuildSource lays one device out by type in a single call, and reports every refusal', async () => {
  const devices = [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }]
  const { service, calls } = serviceWith(
    (operation, params) => {
      if (operation === 'ProjectInfo') return softwareFrame(devices)
      // One call now carries all three families; each lands in its own folder and
      // the device gets exactly one manifest (docs/decisions.md D24).
      return frame('ExportBlocks', params, {
        data: {
          counts: { blocks: 2, types: 3, tagTables: 1 },
          manifest: `${params.output_dir}\\_manifest.json`,
          summary: { exported: 5, skipped: 1, failed: 1, verificationFailed: 0 },
          failures: [{ category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' }],
        },
      })
    },
    RUNNING,
  )

  const result = await service.rebuildSource('C:\\w\\source')
  assert.equal(result.ok, true)
  assert.equal(result.devices.length, 1)
  const device = result.devices[0]

  // One round trip per device, covering all three families.
  const exports = calls.filter((call) => call.operation === 'ExportBlocks')
  assert.equal(exports.length, 1, 'a device must cost exactly one export call')
  assert.deepEqual(exports[0].params.categories, ['blocks', 'types', 'tag_tables'])
  assert.equal(exports[0].params.output_dir, 'C:\\w\\source\\S7-1500')

  assert.equal(device.directory, 'C:\\w\\source\\S7-1500')
  assert.equal(device.blocks.directory, 'C:\\w\\source\\S7-1500\\blocks')
  assert.equal(device.types.directory, 'C:\\w\\source\\S7-1500\\types')
  assert.equal(device.tagTables.directory, 'C:\\w\\source\\S7-1500\\tag_tables')
  assert.equal(device.blocks.exported, 2)
  assert.equal(device.blocks.failed, 1)
  assert.equal(device.types.exported, 3)
  assert.equal(device.tagTables.exported, 1)
  assert.equal(device.skipped, 1, 'skipped comes from the call summary and is device-level')
  assert.equal(device.verificationFailed, 0)
  // One manifest per device, describing all three families: every family reports it.
  assert.match(device.blocks.manifest, /S7-1500\\_manifest\.json$/u)
  assert.equal(device.types.manifest, device.blocks.manifest)
  assert.equal(device.tagTables.manifest, device.blocks.manifest)

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
  // Only device A was exported: one call, naming it and carrying all three families.
  const exports = calls.filter((call) => call.operation === 'ExportBlocks')
  assert.equal(exports.length, 1)
  assert.equal(exports[0].params.device_name, 'A')
  assert.equal(exports[0].params.software_name, 'PLC_A')
  assert.equal(exports[0].params.write_manifest, true)
  assert.equal(exports[0].params.overwrite, false)
  assert.ok(!('dry_run' in exports[0].params), 'the rebuild exports directly; it has no dry run')
  assert.deepEqual(exports[0].params.categories, ['blocks', 'types', 'tag_tables'])
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


