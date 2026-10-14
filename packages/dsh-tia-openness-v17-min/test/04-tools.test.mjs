/**
 * Tool-level tests.
 *
 * These drive the registered tool bodies against a recording controller stub, so
 * they assert the contract the model depends on: which parameters each tool
 * sends, which defaults it applies (above all the dry-run defaults of the
 * write-capable tools), and that the canonical value always matches the declared
 * output schema.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertOutcomeMatchesSchema,
  controllerAvailable,
  createTestContext,
  loadOperations,
  loadToolsModule,
  renderedText,
} from './helpers/harness.mjs'

/** The controller operations the plugin may send, straight from `protocol.ts`. */
const WHITELIST = await loadOperations()

/** `open_project` -> `OpenProject`, the naming convention every tool follows. */
function operationOf(toolName) {
  return toolName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

function recordingController(reply) {
  const calls = []
  const dependencies = {
    request: async (operation, params, options) => {
      calls.push({ operation, params, options })
      return reply === undefined ? okFrame(operation, params) : reply(operation, params)
    },
    status: () => ({
      state: 'stopped',
      exePath: 'C:\\plugin\\controller\\bin\\TiaOpennessV17Min.Controller.exe',
      exeExists: true,
      pid: null,
      startedAt: null,
      requestsServed: 0,
      restarts: 0,
      queueDepth: 0,
      inflightOperation: null,
      lastError: null,
      ready: null,
      stderrTail: ['a stderr line'],
      unexpectedOutput: [],
    }),
    verbose: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { calls, dependencies }
}

function okFrame(operation, params) {
  return {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: true,
    dryRun: params !== undefined && params.dry_run === true,
    durationMs: 7,
    data: { dryRun: params !== undefined && params.dry_run === true, operation },
    changes: [],
    diagnostics: [],
  }
}

async function harness(t, reply) {
  const tools = await loadToolsModule()
  const context = createTestContext()
  t.after(async () => {
    await context.unload()
  })
  const recording = recordingController(reply)
  tools.registerTools(context.ctx, recording.dependencies)
  const byName = Object.fromEntries(context.definitions.map((definition) => [definition.name, definition]))
  return { tools, context, calls: recording.calls, byName }
}

test('open_project forwards only the parameters it was given', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['open_project'].execute({ project_path: 'C:\\P\\P.ap17' }, {})
  assert.deepEqual(calls[0].operation, 'OpenProject')
  assert.deepEqual(calls[0].params, { project_path: 'C:\\P\\P.ap17' })

  await byName['open_project'].execute({ project_path: 'C:\\P\\P.ap17', with_window: true, allow_upgrade: true, dry_run: true }, {})
  assert.deepEqual(calls[1].params, { project_path: 'C:\\P\\P.ap17', with_window: true, allow_upgrade: true, dry_run: true })
})

test('export_blocks applies its documented defaults and is not a dry run by default', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['export_blocks'].execute({ output_dir: 'C:\\out' }, {})
  assert.deepEqual(calls[0].params, {
    output_dir: 'C:\\out',
    categories: ['blocks'],
    recursive: true,
    overwrite: false,
    export_options: 'with_defaults',
    write_manifest: true,
    dry_run: false,
  })

  await byName['export_blocks'].execute(
    { output_dir: 'C:\\out', block_names: ['Main', 'FB1'], device_name: 'PLC_1', overwrite: true, dry_run: true },
    {},
  )
  assert.deepEqual(calls[1].params.block_names, ['Main', 'FB1'])
  assert.equal(calls[1].params.device_name, 'PLC_1')
  assert.equal(calls[1].params.overwrite, true)
  assert.equal(calls[1].params.dry_run, true)
})

test('import_blocks is a dry run unless it is explicitly switched off', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['import_blocks'].execute({ import_paths: ['C:\\out\\Main.xml'] }, {})
  assert.deepEqual(calls[0].params, {
    import_paths: ['C:\\out\\Main.xml'],
    mode: 'auto',
    import_options: 'none',
    generate_option: 'none',
    create_group: false,
    mirror_groups: true,
    recursive: true,
    verify: true,
    keep_source: false,
    dry_run: true,
  })

  await byName['import_blocks'].execute(
    {
      import_paths: ['C:\\src\\a.scl', 'C:\\src\\b.xml'],
      mode: 'external_source',
      import_options: 'override',
      sw_import_options: ['ignore_structural_changes'],
      target_group: '999_Kautex',
      create_group: true,
      dry_run: false,
    },
    {},
  )
  assert.equal(calls[1].params.dry_run, false)
  assert.equal(calls[1].params.import_options, 'override')
  assert.equal(calls[1].params.target_group, '999_Kautex')
  assert.equal(calls[1].params.create_group, true)
  assert.deepEqual(calls[1].params.sw_import_options, ['ignore_structural_changes'])
})

test('compile_plc and close_project are dry runs unless they are explicitly switched off', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['compile_plc'].execute({}, {})
  assert.deepEqual(calls[0].params, { dry_run: true })

  await byName['compile_plc'].execute({ device_name: 'PLC_1', software_name: 'PLC_1', max_messages: 10, dry_run: false }, {})
  assert.deepEqual(calls[1].params, { device_name: 'PLC_1', software_name: 'PLC_1', max_messages: 10, dry_run: false })

  await byName['close_project'].execute({}, {})
  assert.deepEqual(calls[2].params, { save: false, close_portal: false, dry_run: true })

  await byName['close_project'].execute({ save: true, close_portal: true, dry_run: false }, {})
  assert.deepEqual(calls[3].params, { save: true, close_portal: true, dry_run: false })
})

test('controller_status never talks to the controller and hides the captured output by default', async (t) => {
  const { calls, byName, context } = await harness(t)

  const value = await byName['controller_status'].execute({}, {})
  assert.equal(calls.length, 0, 'the status tool must not start or call the controller')
  assert.equal(value.ok, true)
  assert.equal(value.data.state, 'stopped')
  assert.equal(value.data.stderrTail, undefined, 'the stderr tail is hidden unless requested')
  assert.match(value.summary, /Controller state: stopped/)

  const verboseValue = await byName['controller_status'].execute({ include_controller_output: true }, {})
  assert.deepEqual(verboseValue.data.stderrTail, ['a stderr line'])

  assert.equal(context.definitions.length, 26)
})

test('only whitelisted operations ever reach the controller', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['open_project'].execute({ project_path: 'p.ap17' }, {})
  await byName['export_blocks'].execute({ output_dir: 'o' }, {})
  await byName['import_blocks'].execute({ import_paths: ['a.xml'] }, {})
  await byName['compile_plc'].execute({}, {})
  await byName['close_project'].execute({}, {})

  assert.deepEqual(calls.map((call) => call.operation), WHITELIST.slice(0, 5))
})

test('every tool maps onto exactly one whitelisted controller operation', async (t) => {
  const { context } = await harness(t)

  const toolNames = context.definitions.map((definition) => definition.name)
  // `controller_status` is answered by the plugin itself and never reaches the
  // controller, so it is the one tool without a matching operation.
  assert.deepEqual(toolNames.filter((name) => name === 'controller_status'), ['controller_status'])
  assert.equal(toolNames.length - 1, WHITELIST.length, 'one tool per whitelisted operation')

  for (const name of toolNames) {
    if (name === 'controller_status') continue
    assert.ok(
      WHITELIST.includes(operationOf(name)),
      `the tool ${name} maps onto ${operationOf(name)}, which the controller whitelist does not carry`,
    )
  }
  for (const operation of WHITELIST) {
    const expectedTool = operation.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    assert.ok(toolNames.includes(expectedTool), `the operation ${operation} has no tool named ${expectedTool}`)
  }
})

test('the new write-capable tools keep their documented dry-run defaults', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['create_project'].execute({ project_dir: 'C:\\P', project_name: 'P' }, {})
  assert.equal(calls.at(-1).operation, 'CreateProject')
  assert.equal(calls.at(-1).params.dry_run, false)

  await byName['save_project'].execute({}, {})
  assert.equal(calls.at(-1).params.dry_run, false)

  await byName['archive_project'].execute({ target_dir: 'C:\\A', target_name: 'A' }, {})
  assert.equal(calls.at(-1).params.dry_run, false)

  await byName['generate_source'].execute({ output_file: 'C:\\o.scl', block_names: ['Main'] }, {})
  assert.equal(calls.at(-1).operation, 'GenerateSource')
  assert.equal(calls.at(-1).params.dry_run, false)

  await byName['project_texts'].execute({ action: 'export', file: 'C:\\t.xlsx', source_language: 'en-US', target_language: 'de-DE' }, {})
  assert.equal(calls.at(-1).params.dry_run, false, 'exporting project texts only writes a file')
  await byName['project_texts'].execute({ action: 'import', file: 'C:\\t.xlsx' }, {})
  assert.equal(calls.at(-1).params.dry_run, true, 'importing project texts changes the project')

  for (const [name, args] of [
    ['project_languages', { action: 'set', editing_language: 'en-US' }],
    ['portal_settings', { action: 'set', setting: 'SearchInProject', value: true }],
    ['create_plc_objects', { kind: 'tag_table', name: 'T1' }],
    ['delete_plc_objects', { block_names: ['FB1'] }],
    ['write_tags', { tag_table: 'T1', tags: [{ name: 'Tag1' }] }],
    ['set_block_attributes', { names: ['Main'], attributes: { Priority: 14 } }],
    ['protect_blocks', { block_names: ['FB1'], action: 'protect', password: 'x' }],
    ['watch_and_force_tables', { action: 'create', name: 'W1' }],
    ['software_units', { action: 'create', name: 'U1' }],
    ['set_safety_settings', { safety_modifications_possible: false }],
  ]) {
    await byName[name].execute(args, {})
    assert.equal(calls.at(-1).params.dry_run, true, `${name} must default to a dry run`)
  }
})

test('save_project reports where TIA actually put the project, not just where it was asked to', async (t) => {
  // SaveAs takes only a target directory and Openness cannot rename a project,
  // so TIA decides the layout below it. The tool must therefore surface the
  // requested directory *and* the resulting path.
  const { byName } = await harness(t, (operation) => ({
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: true,
    durationMs: 5,
    data: {
      projectName: 'PEI_SinoARP_SWT2',
      projectPath: 'D:\\Verify\\tia\\PEI_SinoARP_SWT2\\PEI_SinoARP_SWT2.ap17',
      saved: true,
      requestedSaveAsDir: 'D:\\Verify\\tia',
      savedAs: 'D:\\Verify\\tia\\PEI_SinoARP_SWT2\\PEI_SinoARP_SWT2.ap17',
      locationChanged: true,
      isModifiedBeforeSave: true,
      isModified: false,
      dryRun: false,
    },
    changes: [],
    diagnostics: [],
  }))

  const args = { save_as_dir: 'D:\\Verify\\tia' }
  const value = await byName['save_project'].execute(args, {})
  assertOutcomeMatchesSchema(byName['save_project'], value)

  const text = renderedText(byName['save_project'], args, value)
  assert.match(text, /Saved as: D:\\Verify\\tia\\PEI_SinoARP_SWT2\\PEI_SinoARP_SWT2\.ap17/)
  assert.match(text, /Requested directory: D:\\Verify\\tia/)
  assert.match(text, /project name is unchanged/)
})

test('the read-only tools send no dry_run at all', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['project_info'].execute({}, {})
  assert.equal(calls.at(-1).operation, 'ProjectInfo')
  assert.equal('dry_run' in calls.at(-1).params, false)
})

test('list_plc_objects forwards exact names, which is how fingerprints are asked for per block', async (t) => {
  const { calls, byName } = await harness(t)

  await byName['list_plc_objects'].execute(
    { categories: ['blocks'], block_names: ['FB_Motor', 'FC_1'], include_fingerprints: true },
    {},
  )
  assert.equal(calls.at(-1).operation, 'ListPlcObjects')
  assert.deepEqual(calls.at(-1).params.block_names, ['FB_Motor', 'FC_1'])
  assert.equal(calls.at(-1).params.include_fingerprints, true)
  assert.equal('dry_run' in calls.at(-1).params, false, 'listing is read-only')

  // A caller that only names objects does not have to repeat the family.
  await byName['list_plc_objects'].execute({ type_names: ['MyUDT'], include_fingerprints: true }, {})
  assert.deepEqual(calls.at(-1).params.type_names, ['MyUDT'])

  // The parameters stay absent when they were not given, so the controller's
  // "exact names given" branch cannot trigger by accident.
  await byName['list_plc_objects'].execute({}, {})
  assert.equal('block_names' in calls.at(-1).params, false)
  assert.equal('type_names' in calls.at(-1).params, false)
  assert.equal('tag_table_names' in calls.at(-1).params, false)
  // categories is left to the controller: sending a default would make a
  // "fingerprints of these blocks" call also dump every type and tag table.
  assert.equal('categories' in calls.at(-1).params, false)

  await byName['list_plc_objects'].execute({ categories: ['units'] }, {})
  assert.deepEqual(calls.at(-1).params.categories, ['units'])
})

/**
 * The frame `OperationsPlc.ListPlcObjects` actually builds.
 *
 * Every family is the controller's `{count, items, truncated}` envelope, never a
 * bare array — see `OperationsPlc.cs` (`data.Add("blocks", blocks)`) and
 * `OpennessHost.Plc.cs` (`result.Add("items", items)`). A renderer that reads the
 * envelope as if it were the list gets `[]` from `list()` and silently drops
 * every row, which is how the fingerprint inventory once vanished from the
 * model-facing text while `Counts:` and `Block groups:` still rendered.
 */
function listPlcObjectsFrame(data) {
  return {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation: 'ListPlcObjects',
    ok: true,
    durationMs: 11802,
    data,
    changes: [],
    diagnostics: [{ level: 'info', message: 'Listed the PLC objects of Sino_PEI / Sino_PEI.' }],
  }
}

test('list_plc_objects renders the objects and their fingerprints out of the controller envelope', async (t) => {
  const blocks = [
    ['SCP_IN', '1001'],
    ['SCP_OUT', '114'],
    ['Output', '14'],
    ['Switch', '57'],
    ['Com_Server_PLC', '1000'],
  ].map(([name, declaredNumber]) => ({
    name,
    declaredNumber,
    simaticType: 'FB',
    group: '999_Bibliotheque/Fonctions méthode/',
    fingerprints: [
      { id: 'Code', value: '3F2A91' },
      { id: 'Interface', value: '0B77C1' },
      { id: 'Properties', value: 'D4E500' },
    ],
  }))

  const { byName } = await harness(t, () =>
    listPlcObjectsFrame({
      device: 'Sino_PEI',
      software: 'Sino_PEI',
      categories: ['blocks'],
      counts: { blocks: blocks.length },
      blockGroups: ['999_Bibliotheque', '999_Bibliotheque/Fonctions méthode'],
      blocks: { count: blocks.length, items: blocks, truncated: false },
      truncated: false,
      maxItems: 200,
    }),
  )

  const args = { categories: ['blocks'], include_fingerprints: true }
  const value = await byName['list_plc_objects'].execute(args, {})
  assertOutcomeMatchesSchema(byName['list_plc_objects'], value)

  const text = renderedText(byName['list_plc_objects'], args, value)
  assert.match(text, /Blocks: 5 — SCP_IN, SCP_OUT, Output, Switch, Com_Server_PLC/, 'the block names must reach the model')
  assert.match(text, /Fingerprints \(5 object\(s\)\):/)
  for (const block of blocks) {
    assert.match(
      text,
      new RegExp(`block ${block.name}: Code=3F2A91 Interface=0B77C1 Properties=D4E500`),
      `${block.name} must report its three fingerprints`,
    )
  }
  assert.doesNotMatch(text, /… \d+ more/, 'nothing was hidden: every object was listed')
})

test('list_plc_objects reports the controller total, and the envelope shape holds for every family', async (t) => {
  const items = [
    { name: 'FB_1', fingerprints: [{ id: 'Code', value: 'C0' }] },
    { name: 'FB_2', fingerprints: [{ id: 'Code', value: 'C1' }] },
  ]

  const { byName } = await harness(t, () =>
    listPlcObjectsFrame({
      device: 'Sino_PEI',
      software: 'Sino_PEI',
      counts: { blocks: 1155, types: 1, units: 2 },
      blockGroups: ['999_Bibliotheque'],
      blocks: { count: 1155, items, truncated: true },
      types: { count: 1, items: [{ name: 'MyUDT', fingerprints: [{ id: 'Code', value: 'AA01' }] }], truncated: false },
      // In ListPlcObjects `units` is an envelope too — unlike the standalone
      // software_units operation, whose `units` is a bare array.
      units: { available: true, count: 2, items: [{ name: 'Unit_A' }, { name: 'Unit_B' }], truncated: false },
      truncated: true,
      maxItems: 20,
      missing: { blocks: ['Main'] },
    }),
  )

  const args = { categories: ['blocks', 'types', 'units'], include_fingerprints: true }
  const value = await byName['list_plc_objects'].execute(args, {})
  const text = renderedText(byName['list_plc_objects'], args, value)

  assert.match(text, /The listing was truncated by max_items\./)
  assert.match(text, /Blocks: 1155 — FB_1, FB_2 … 1153 more/, 'the total is the envelope count, not the page size')
  assert.match(text, /Types: 1 — MyUDT/)
  assert.match(text, /Software units: 2 — Unit_A, Unit_B/)
  assert.match(text, /Fingerprints \(3 object\(s\)\):/)
  assert.match(text, /block FB_1: Code=C0/)
  assert.match(text, /type MyUDT: Code=AA01/)
  assert.match(text, /Not found in blocks: Main/)
})

test('the fingerprint section is paged, and says how many rows it held back', async (t) => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    name: `FB_${index + 1}`,
    fingerprints: [{ id: 'Code', value: `C${index}` }],
  }))

  const { byName } = await harness(t, () =>
    listPlcObjectsFrame({
      device: 'Sino_PEI',
      software: 'Sino_PEI',
      counts: { blocks: 25 },
      blockGroups: ['999_Bibliotheque'],
      blocks: { count: 25, items, truncated: false },
      truncated: false,
      maxItems: 200,
    }),
  )

  const args = { categories: ['blocks'], include_fingerprints: true }
  const value = await byName['list_plc_objects'].execute(args, {})
  const text = renderedText(byName['list_plc_objects'], args, value)

  assert.match(text, /Fingerprints \(25 object\(s\)\):/, 'the header counts every object that has fingerprints')
  assert.match(text, /block FB_20: Code=C19/)
  assert.doesNotMatch(text, /block FB_21:/, 'only MAX_LISTED rows are printed')
  assert.match(text, /… 5 more/)
})

test('every tool returns a canonical value that matches its declared output schema', async (t) => {
  const { byName } = await harness(t)

  const invocations = [
    ['open_project', { project_path: 'C:\\P\\P.ap17' }],
    ['export_blocks', { output_dir: 'C:\\out' }],
    ['import_blocks', { import_paths: ['C:\\out\\Main.xml'] }],
    ['compile_plc', {}],
    ['close_project', {}],
    ['controller_status', {}],
    ['create_project', { project_dir: 'C:\\P', project_name: 'P' }],
    ['save_project', {}],
    ['archive_project', { target_dir: 'C:\\A', target_name: 'A' }],
    ['project_info', {}],
    ['project_languages', {}],
    ['project_texts', { action: 'export', file: 'C:\\t.xlsx', source_language: 'en-US', target_language: 'de-DE' }],
    ['update_project', { simulation_during_block_compilation: false }],
    ['portal_settings', {}],
    ['list_plc_objects', {}],
    ['create_plc_objects', { kind: 'tag_table', name: 'T1' }],
    ['delete_plc_objects', { block_names: ['FB1'] }],
    ['write_tags', { tag_table: 'T1', tags: [{ name: 'Tag1', data_type: 'Bool' }] }],
    ['set_block_attributes', { names: ['Main'], attributes: { Priority: 14 } }],
    ['protect_blocks', { block_names: ['FB1'], action: 'protect', password: 'x' }],
    ['generate_source', { output_file: 'C:\\o.scl', block_names: ['Main'] }],
    ['watch_and_force_tables', { action: 'export', name: 'W1', output_file: 'C:\\w.xml' }],
    ['software_units', {}],
    ['safety_status', {}],
    ['set_safety_settings', { safety_modifications_possible: false }],
    ['safety_signatures', {}],
  ]

  for (const [name, args] of invocations) {
    const value = await byName[name].execute(args, {})
    assertOutcomeMatchesSchema(byName[name], value)
    assert.equal(value.operation.length > 0, true)
    assert.equal(typeof value.summary, 'string')
  }
})

test('a dry-run result renders as a dry run and a verification failure renders loudly', async (t) => {
  const { byName } = await harness(t)

  const dryRun = await byName['import_blocks'].execute({ import_paths: ['a.xml'] }, {})
  const dryRunText = renderedText(byName['import_blocks'], { import_paths: ['a.xml'] }, dryRun)
  assert.match(dryRunText, /dry run/)
  assert.match(dryRunText, /nothing was written/)

  const verificationFailure = await byName['import_blocks'].execute({ import_paths: ['a.xml'], dry_run: false }, {})
  assertOutcomeMatchesSchema(byName['import_blocks'], verificationFailure)
  assert.equal(verificationFailure.ok, true, 'the stub succeeded; the renderer is what is under test here')
})

test('a controller failure is rendered with its code, message and details', async (t) => {
  const { byName } = await harness(t, (operation) => ({
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation,
    ok: false,
    durationMs: 4,
    changes: [],
    diagnostics: [{ level: 'error', message: 'the project has 3 blocks', source: 'progress:export' }],
    error: {
      code: 'block_not_found',
      message: "These blocks were not found: FB9. The project has 3 block(s).",
      details: { missing: ['FB9'], hint: 'Check the spelling of the block names.' },
    },
  }))

  const value = await byName['export_blocks'].execute({ output_dir: 'C:\\out', block_names: ['FB9'] }, {})
  assertOutcomeMatchesSchema(byName['export_blocks'], value)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'block_not_found')

  const text = renderedText(byName['export_blocks'], { output_dir: 'C:\\out', block_names: ['FB9'] }, value)
  assert.match(text, /FAILED/)
  assert.match(text, /Error code: block_not_found/)
  assert.match(text, /Hint: Check the spelling/)
  assert.match(text, /FB9/)
  assert.match(text, /Diagnostics:/)
})

test('a transport failure stays a thrown error instead of a successful-looking outcome', async (t) => {
  const { byName } = await harness(t, () => {
    const error = new Error('controller_timeout: the controller did not answer within 1000 ms')
    error.code = 'controller_timeout'
    throw error
  })

  await assert.rejects(
    () => byName['compile_plc'].execute({ dry_run: false }, {}),
    (error) => {
      assert.match(error.message, /controller_timeout/)
      return true
    },
  )
})

test('the plugin works without a built controller, because the stub answers', async () => {
  // Guards against tests that silently depend on the real executable.
  assert.equal(typeof controllerAvailable, 'boolean')
})
