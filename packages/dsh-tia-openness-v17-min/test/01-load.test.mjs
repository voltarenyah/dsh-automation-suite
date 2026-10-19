/**
 * Minimal load test: both Loader rows must load through the loader contract.
 *
 * This is the test the checklist names first ("插件能被 DSH 正确加载"). It asserts
 * the three rules that plugins get wrong: module-level exports, a complete
 * `inject`, and tool definitions that the *real* tool runtime accepts. Since the
 * tool registration moved to the `/tools` row, the tool-facing assertions run
 * against `lib/tools-entry.js`; the host row must stay tool-free so an agent
 * preset can leave it undeclared.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertOutcomeMatchesSchema,
  checkedArgs,
  controllerAvailable,
  createTestContext,
  dshTools,
  EXPECTED_TOOLS,
  loadPlugin,
  loadRuntimeModule,
  loadToolsEntry,
  loadToolsModule,
  parameterViolations,
  renderedText,
  withPlugin,
  withTools,
} from './helpers/harness.mjs'

test('the host row exports name, inject, Config and apply at module level', async () => {
  const plugin = await loadPlugin()

  assert.equal(plugin.name, 'tia-openness-v17-min')
  // The host row registers no tool now, so it has nothing to wait for: `skills`
  // stays optional through `ctx.inject` inside `apply`.
  assert.deepEqual(plugin.inject, [], 'the host row waits for no service')
  assert.equal(typeof plugin.apply, 'function')
  assert.notEqual(plugin.Config, undefined, 'a Config schema must be exported so profiles can configure the plugin')
})

test('the /tools row exports its own name, inject and apply at module level', async () => {
  const entry = await loadToolsEntry()
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()

  assert.equal(entry.name, 'tia-openness-v17-min-tools')
  // The tool registry is where the tools go; the runtime seam is the host row's
  // controller. Declaring both is what makes the loader wait for them.
  assert.deepEqual(entry.inject, ['tools', TIA_RUNTIME_SERVICE])
  assert.equal(typeof entry.apply, 'function')
})

test('the /tools row registers every tool exactly once on ctx.tools', async (t) => {
  const { harness } = await withTools(t)

  assert.deepEqual(harness.registered().sort(), [...EXPECTED_TOOLS].sort())
  for (const definition of harness.definitions) {
    assert.equal(typeof definition.execute, 'function', `${definition.name} has an execute body`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name} declares a renderer`)
    assert.equal(definition.output.schema.type, 'object', `${definition.name} declares an object output schema`)
  }
})

test('the /tools row registers exactly the 26 names, in the order the host row used to', async (t) => {
  const { harness } = await withTools(t)

  // Order is part of the model-facing contract: the tool list is rendered in
  // registration order, so a reordering is a visible change even when the set is
  // identical.
  assert.deepEqual(harness.registered(), EXPECTED_TOOLS)
})

test('the host row registers no model-facing tool at all', async (t) => {
  const { harness } = await withPlugin(t, { controllerPath: 'C:\\does\\not\\exist\\controller.exe' })
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()

  assert.deepEqual(harness.registered(), [], 'the host row must not leak tools into the host (global) plane')
  assert.notEqual(
    harness.ctx.get(TIA_RUNTIME_SERVICE),
    undefined,
    'the host row still publishes the seam its /tools row reads',
  )
})

test('the /tools row refuses to load without the host row', async (t) => {
  const entry = await loadToolsEntry()
  const { TIA_RUNTIME_SERVICE } = await loadRuntimeModule()
  const harness = createTestContext()
  t.after(async () => {
    await harness.unload()
  })

  // `inject` is what prevents this in a real composition; applying the row by
  // hand must fail loudly instead of registering tools that cannot reach TIA.
  assert.throws(() => entry.apply(harness.ctx, {}), new RegExp(TIA_RUNTIME_SERVICE))
  assert.deepEqual(harness.registered(), [])
})

test('every declared parameter and output schema compiles in the real tool runtime', async (t) => {
  const { harness } = await withTools(t)

  for (const definition of harness.definitions) {
    const parameters = definition.parameters
    assert.equal(parameters.type, 'object', `${definition.name} compiles to an object-rooted parameter schema`)
    assert.equal(typeof parameters.properties, 'object', `${definition.name} projects its properties`)
    dshTools.assertSupportedJsonSchema(definition.output.schema)
  }

  const byName = Object.fromEntries(harness.definitions.map((definition) => [definition.name, definition]))
  assert.deepEqual(byName['open_project'].parameters.required, ['project_path'])
  assert.deepEqual(byName['export_blocks'].parameters.required, ['output_dir'])
  assert.deepEqual(byName['import_blocks'].parameters.required, ['import_paths'])
  assert.equal(byName['controller_status'].parameters.required, undefined, 'controller_status has no required parameter')

  // Enum constraints survive the projection, which is what keeps the model from
  // inventing values for the option parameters.
  assert.deepEqual(byName['export_blocks'].parameters.properties.export_options.enum, ['none', 'with_defaults', 'with_read_only'])
  assert.deepEqual(byName['import_blocks'].parameters.properties.import_options.enum, ['none', 'override'])
  assert.equal(byName['import_blocks'].parameters.properties.import_paths.type, 'array')
})

test('the registry validator rejects missing required, wrong-typed and out-of-enum arguments', async (t) => {
  const { harness } = await withTools(t)
  const byName = Object.fromEntries(harness.definitions.map((definition) => [definition.name, definition]))
  const openProject = byName['open_project']
  const exportBlocks = byName['export_blocks']
  const importBlocks = byName['import_blocks']

  assert.equal(parameterViolations(openProject, { project_path: 'x' }).length, 0)
  assert.deepEqual(parameterViolations(openProject, { project_path: 'x' }).length, 0)
  assert.ok(parameterViolations(openProject, {}).length > 0, 'a missing required parameter is a violation')
  assert.ok(parameterViolations(openProject, { project_path: 7 }).length > 0, 'a wrongly typed parameter is a violation')
  assert.ok(parameterViolations(exportBlocks, { output_dir: 'x', export_options: 'whatever' }).length > 0, 'an out-of-enum value is a violation')
  assert.ok(parameterViolations(importBlocks, { import_paths: 'not-an-array' }).length > 0, 'a scalar where an array is declared is a violation')
  assert.equal(parameterViolations(importBlocks, { import_paths: ['a.xml'], mode: 'auto', dry_run: true }).length, 0)
})

test('the model-facing descriptions name the operation, the dry-run policy and the failures', async (t) => {
  const { harness } = await withTools(t)

  for (const definition of harness.definitions) {
    assert.ok(definition.description.length > 120, `${definition.name} has a descriptive description`)
  }

  const importBlocks = harness.definitions.find((definition) => definition.name === 'import_blocks')
  assert.match(importBlocks.description, /dry_run/, 'import_blocks explains its dry-run default')
  assert.match(importBlocks.description, /transaction/i, 'import_blocks explains the transaction')
  assert.match(importBlocks.description, /verification_failed/, 'import_blocks names its error codes')

  const exportBlocks = harness.definitions.find((definition) => definition.name === 'export_blocks')
  assert.match(exportBlocks.description, /block_not_found/, 'export_blocks names its error codes')

  const compilePlc = harness.definitions.find((definition) => definition.name === 'compile_plc')
  assert.doesNotMatch(compilePlc.description, /dry_run/, 'compile_plc no longer offers a dry run')
  assert.match(compilePlc.description, /errorCount/, 'compile_plc explains how compile errors are reported')

  const controllerStatus = harness.definitions.find((definition) => definition.name === 'controller_status')
  assert.match(controllerStatus.description, /Siemens TIA Openness/, 'controller_status explains the user group check')
})

test('a canonical value produced by the tools satisfies its declared output schema', async (t) => {
  const tools = await loadToolsModule()
  const harness = createTestContext()
  t.after(async () => {
    await harness.unload()
  })

  const dependencies = {
    request: async (operation) => ({
      type: 'result',
      protocol: 1,
      id: 'test',
      operation,
      ok: true,
      dryRun: true,
      durationMs: 5,
      data: { dryRun: true, projectName: 'Demo' },
      changes: [],
      diagnostics: [{ level: 'info', message: 'dry run' }],
    }),
    status: () => ({ state: 'stopped', exePath: 'x', exeExists: false, requestsServed: 0 }),
    verbose: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }

  tools.registerTools(harness.ctx, dependencies)

  const openProject = harness.definitions.find((definition) => definition.name === 'open_project')
  const args = checkedArgs(openProject, { project_path: 'C:\\Demo\\Demo.ap17' })
  const value = await openProject.execute(args, {})

  assertOutcomeMatchesSchema(openProject, value)
  const text = renderedText(openProject, args, value)
  assert.match(text, /dry run/, 'the renderer explains that nothing was written')
})

test('a failure reported by the controller is a structured outcome, not a thrown error', async (t) => {
  const tools = await loadToolsModule()
  const harness = createTestContext()
  t.after(async () => {
    await harness.unload()
  })

  const dependencies = {
    request: async (operation) => ({
      type: 'result',
      protocol: 1,
      id: 'test',
      operation,
      ok: false,
      durationMs: 3,
      data: undefined,
      changes: [],
      diagnostics: [{ level: 'error', message: 'no such block' }],
      error: { code: 'block_not_found', message: 'These blocks were not found: FB9', details: { missing: ['FB9'] } },
    }),
    status: () => ({}),
    verbose: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }

  tools.registerTools(harness.ctx, dependencies)

  const exportBlocks = harness.definitions.find((definition) => definition.name === 'export_blocks')
  const value = await exportBlocks.execute(checkedArgs(exportBlocks, { output_dir: 'C:\\out' }), {})

  assertOutcomeMatchesSchema(exportBlocks, value)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'block_not_found')
  const text = renderedText(exportBlocks, { output_dir: 'C:\\out' }, value)
  assert.match(text, /FAILED/)
  assert.match(text, /block_not_found/)
})

test('the rows load without a controller build and the host row still reports a clear reason', async (t) => {
  if (controllerAvailable) {
    t.skip('the controller is built, so the missing-controller path cannot be exercised here')
    return
  }

  const plugin = await loadPlugin()
  const harness = createTestContext()
  t.after(async () => {
    await harness.unload()
  })
  plugin.apply(harness.ctx, {})

  assert.deepEqual(harness.registered(), [], 'the host row registers no model-facing tool')
  const warning = harness.logs.find((entry) => entry[0] === 'warn')
  assert.notEqual(warning, undefined, 'loading logs a warning that names the missing controller')
  assert.match(warning[2], /was not found/)

  const entry = await loadToolsEntry()
  entry.apply(harness.ctx, {})
  assert.equal(harness.registered().length, EXPECTED_TOOLS.length, 'the /tools row registers them anyway')
})
