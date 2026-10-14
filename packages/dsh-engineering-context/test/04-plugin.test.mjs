/**
 * The plugin entry point: identity, registration, configuration hygiene, and
 * whether the **real** harness runtime accepts what this plugin declares.
 *
 * The last one matters most: `defineTool` compiles the parameter and output
 * schemas before any registry sees them, so running the definitions through the
 * runtime the harness actually ships is what proves the declared contract is
 * one the runtime would accept (a hand-written stub would prove nothing).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as dshTools from '@deepseek-ai/dsh-tools'

import { createTestContext, loadConfigModule, loadPlugin, loadToolsModule } from './helpers/harness.mjs'

const plugin = await loadPlugin()
const { configDefaults, resolveConfig } = await loadConfigModule()
const { TOOL_NAMES } = await loadToolsModule()

test('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(plugin.name, 'engineering-context')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'the profile needs a Config schema to validate the config block')
})

test('apply registers every tool in a stable order and reports it once', () => {
  const { ctx, definitions, logs } = createTestContext()
  plugin.apply(ctx, {})
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [...TOOL_NAMES],
  )
  const info = logs.filter((entry) => entry.level === 'info')
  assert.equal(info.length, 1)
  assert.match(info[0].message, /Registered 4 engineering-context tools/u)
})

test('apply works with no config block at all', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx)
  assert.equal(definitions.length, TOOL_NAMES.length)
})

test('every tool answers the three questions a model needs', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, {})
  for (const definition of definitions) {
    assert.ok(definition.description.length > 200, `${definition.name} needs a substantive description`)
    assert.equal(typeof definition.output.render, 'function')
    const rendered = definition.output.render(undefined, {
      ok: true,
      tool: definition.name,
      dryRun: true,
      summary: 'x',
      details: ['d'],
      scope: null,
      data: null,
      warnings: [],
      error: null,
    })
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].type, 'text')
  }
})

test('configuration defaults are complete and unusable values fall back', () => {
  assert.deepEqual(resolveConfig(), configDefaults)
  assert.equal(resolveConfig({ stateDirName: '_state' }).stateDirName, '_state')

  // These would move every write, so they fall back rather than being trusted.
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '.', '', '   ', 'C:', 'nul']) {
    assert.equal(resolveConfig({ stateDirName: bad }).stateDirName, configDefaults.stateDirName, `stateDirName ${bad}`)
    assert.equal(resolveConfig({ projectsDirName: bad }).projectsDirName, configDefaults.projectsDirName, `projectsDirName ${bad}`)
  }

  assert.equal(resolveConfig({ requireWorkspace: 'yes' }).requireWorkspace, true)
  assert.equal(resolveConfig({ requireWorkspace: false }).requireWorkspace, false)
  assert.equal(resolveConfig({}).requireWorkspace, true, 'fail-closed is the default')
})

test('the real harness runtime holds these schemas and validates our results', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, {})

  /** A plausible argument set: the first enum value, or a value of the right type. */
  const minimalArgs = (parameters) => {
    const args = {}
    for (const name of parameters.required ?? []) {
      const property = parameters.properties?.[name] ?? { type: 'string' }
      if (Array.isArray(property.enum) && property.enum.length > 0) args[name] = property.enum[0]
      else if (property.type === 'boolean') args[name] = false
      else if (property.type === 'number' || property.type === 'integer') args[name] = 0
      else args[name] = 'x'
    }
    return args
  }

  for (const definition of definitions) {
    // `defineTool` compiled the declared spec, so what the definition carries IS
    // what the registry validates against — recompiling it here would only test
    // the compiler twice.
    const output = definition.output.schema
    const parameters = definition.parameters

    const envelope = {
      ok: true,
      tool: definition.name,
      dryRun: true,
      summary: 'summary',
      details: ['detail'],
      scope: null,
      data: null,
      warnings: [],
      error: null,
    }
    assert.deepEqual(
      dshTools.validateJsonSchemaValue(output, envelope),
      [],
      `${definition.name}: a real envelope must satisfy the declared output schema`,
    )

    // `additionalProperties: false` is real, so an undeclared key is caught.
    assert.ok(
      dshTools.validateJsonSchemaValue(output, { ...envelope, unexpected: 1 }).length > 0,
      `${definition.name}: an undeclared property must be rejected`,
    )

    // Every parameter the schema declares as required is enforced, and a
    // plausible call passes.
    const required = Array.isArray(parameters.required) ? parameters.required : []
    if (required.length > 0) {
      const issues = dshTools.validateJsonSchemaValue(parameters, {})
      for (const name of required) {
        assert.ok(
          issues.some((issue) => issue.includes(name)),
          `${definition.name}: omitting the required '${name}' must be reported`,
        )
      }
      assert.deepEqual(
        dshTools.validateJsonSchemaValue(parameters, minimalArgs(parameters)),
        [],
        `${definition.name}: a plausible argument set must be accepted`,
      )
    }
  }
})
