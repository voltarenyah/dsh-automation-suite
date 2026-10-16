/**
 * The plugin entry point: identity, registration, configuration hygiene, and
 * whether the **real** harness runtime accepts what this plugin declares.
 *
 * The last one matters most: `defineTool` compiles the parameter and output
 * schemas before any registry sees them, so running the definition through the
 * runtime the harness actually ships is what proves the declared contract is
 * one the runtime would accept (a hand-written stub would prove nothing).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as dshTools from '@deepseek-ai/dsh-tools'

import { createTestContext, loadConfigModule, loadPlugin, loadToolsModule, renderedText } from './helpers/harness.mjs'

const plugin = await loadPlugin()
const { configDefaults, resolveConfig } = await loadConfigModule()
const { TOOL_NAMES } = await loadToolsModule()

test('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(plugin.name, 'engineering-context')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'the profile needs a Config schema to validate the config block')
})

test('apply registers the one tool in a stable order and reports it once', () => {
  const { ctx, definitions, logs } = createTestContext()
  plugin.apply(ctx, {})

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [...TOOL_NAMES],
  )
  const info = logs.filter((entry) => entry.level === 'info')
  assert.equal(info.length, 1)
  assert.match(info[0].message, /Registered 1 engineering-context tool/u)
  assert.match(info[0].message, /<workspace>\/tia\//u)
})

test('apply works with no config block at all', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx)
  assert.equal(definitions.length, TOOL_NAMES.length)
})

test('the tool answers the three questions a model needs', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, {})

  for (const definition of definitions) {
    assert.ok(definition.description.length > 200, `${definition.name} needs a substantive description`)
    assert.match(definition.description, /dry_run: true/u, 'the plan-by-default rule belongs in the description')
    assert.equal(typeof definition.output.render, 'function')

    const rendered = renderedText(definition, {}, {
      ok: true,
      tool: definition.name,
      dryRun: true,
      summary: 'x',
      details: ['d'],
      scope: { workspace: { path: 'C:\\ws', registered: true, title: null }, warnings: [] },
      data: null,
      warnings: [],
      error: null,
    })
    assert.match(rendered, new RegExp(`${definition.name}: x`, 'u'))
    assert.match(rendered, /Scope: workspace C:\\ws/u)
  }
})

test('configuration defaults are complete and unusable values fall back', () => {
  assert.deepEqual(resolveConfig(), configDefaults)
  assert.equal(resolveConfig({ tiaDirName: 'projects' }).tiaDirName, 'projects')
  assert.equal(resolveConfig({ sourceDirName: 'src' }).sourceDirName, 'src')

  // These would move every write, so they fall back rather than being trusted.
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '.', '', '   ', 'C:', 'nul', 'trailing.']) {
    assert.equal(resolveConfig({ tiaDirName: bad }).tiaDirName, configDefaults.tiaDirName, `tiaDirName ${bad}`)
    assert.equal(resolveConfig({ sourceDirName: bad }).sourceDirName, configDefaults.sourceDirName, `sourceDirName ${bad}`)
  }

  assert.equal(resolveConfig({ requireWorkspace: 'yes' }).requireWorkspace, true)
  assert.equal(resolveConfig({ requireWorkspace: false }).requireWorkspace, false)
  assert.equal(resolveConfig({}).requireWorkspace, true, 'fail-closed is the default')
})

test('the real harness runtime holds this schema and validates the result', () => {
  const { ctx, definitions } = createTestContext()
  plugin.apply(ctx, {})

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

    // Every parameter is optional (the plan is the default), so an empty call and
    // a full one must both be accepted.
    assert.deepEqual(
      dshTools.validateJsonSchemaValue(parameters, {}),
      [],
      `${definition.name}: calling it with no arguments must be a valid plan request`,
    )
    assert.deepEqual(
      dshTools.validateJsonSchemaValue(parameters, { dry_run: false, overwrite: true }),
      [],
      `${definition.name}: the real-run argument set must be accepted`,
    )
    assert.ok(
      dshTools.validateJsonSchemaValue(parameters, { dry_run: 'yes' }).length > 0,
      `${definition.name}: a mistyped argument must be reported`,
    )
  }
})
