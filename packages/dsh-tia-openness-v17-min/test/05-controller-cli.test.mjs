/**
 * Tests of the C# controller's own contract, driven from the outside.
 *
 * The controller is a separate program, so it is tested the way an operator uses
 * it: through its command line and its NDJSON channel. `--self-test` covers the
 * behaviour that needs no TIA Portal (protocol framing, JSON, argument
 * validation, the operation whitelist and the Simatic ML readers); the remaining
 * tests cover the CLI surface.
 *
 * The operations that talk to TIA Portal are covered by the functional test in
 * `docs/FUNCTIONAL-TEST.md`, which needs a real V17 project.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { controllerAvailable, controllerExe, loadOperations } from './helpers/harness.mjs'

/**
 * The controller's own list is asserted by the C# self test
 * (`whitelist_exact`); this module-level copy is the plugin's, so the two tests
 * fail together when only one side of the wire contract is updated.
 */
const OPERATIONS = await loadOperations()

const run = promisify(execFile)

async function controller(args, options = {}) {
  try {
    const { stdout, stderr } = await run(controllerExe, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000, ...options })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('the controller self test passes', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const result = await controller(['--self-test'])
  assert.equal(result.code, 0, `the self test must pass:\n${result.stdout}\n${result.stderr}`)

  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.failedCount, 0)
  assert.equal(report.protocol, 1)

  const names = report.checks.map((check) => check.name)
  for (const expected of [
    'whitelist_exact',
    'whitelist_rejects_unknown',
    'json_roundtrip',
    'json_escaping',
    'args_accessors',
    'args_rejects_wrong_type',
    'result_frame_shape',
    'simatic_ml_header',
    'simatic_ml_rejects_garbage',
    'external_source_scan',
    'sha256_matches_known_vector',
    'openness_not_loaded_by_startup',
    'siemens_resolver_package_present',
  ]) {
    assert.ok(names.includes(expected), `the self test must cover ${expected}`)
  }

  // Starting the controller must not load the Openness assembly; Siemens'
  // resolver initializes at the first operation instead.
  assert.equal(report.checks.find((check) => check.name === 'openness_not_loaded_by_startup').ok, true)
  assert.equal(report.checks.find((check) => check.name === 'siemens_resolver_package_present').ok, true)
})

test('the self test reports the Openness installation and the user group membership', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const report = JSON.parse((await controller(['--self-test'])).stdout)
  assert.equal(typeof report.openness.opennessDir, 'string')

  if (report.openness.available !== false) {
    assert.match(report.openness.assemblyPath, /Siemens\.Engineering\.dll$/)
    assert.match(report.openness.assemblyVersion, /^17\./)
    assert.match(report.openness.processorArchitecture, /MSIL|Amd64/)
    // The probe reports where the Siemens.Engineering assembly was found, using
    // the same registry value Siemens' own reference package reads.
    assert.ok(
      ['registry', 'TiaPortalLocation', 'configured'].includes(report.openness.resolvedFrom),
      `an unexpected resolution source: ${report.openness.resolvedFrom}`,
    )
    assert.equal(report.openness.tiaMajorVersion, 17)
    // The Openness loading itself is Siemens' NuGet resolver; the controller keeps
    // a fallback probe as insurance, whose candidate folders are reported here.
    assert.match(report.openness.resolver, /Openness\.Resolver$/)
    assert.ok(Array.isArray(report.openness.candidateDirectories))
    assert.ok(report.openness.candidateDirectories.length >= 2, 'the fallback probe lists its candidate folders')
  }

  // A missing group membership is reported, not treated as a fatal error.
  assert.equal(typeof report.opennessUserGroup.group, 'string')
})

test('--version and --help describe the whitelist', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const version = await controller(['--version'])
  assert.equal(version.code, 0)
  const frame = JSON.parse(version.stdout)
  assert.equal(frame.controller, 'TiaOpennessV17Min.Controller')
  assert.deepEqual(frame.operations, OPERATIONS)

  const help = await controller(['--help'])
  assert.equal(help.code, 0)
  for (const operation of OPERATIONS) {
    assert.match(help.stdout, new RegExp(operation))
  }
  assert.match(help.stdout, /TIA_OPENNESS_V17_DIR/)
})

test('a non-whitelisted operation is refused on the command line too', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const result = await controller(['--operation', 'RunScript', '--param', 'code=System.IO.File.Delete("x")'])
  assert.equal(result.code, 2, 'a refused operation exits with the failure code')

  // The refusal is structured even in one-shot mode: the last line is the frame.
  const lines = result.stdout.trim().split('\n')
  const frame = JSON.parse(lines[lines.length - 1])
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'unsupported_operation')
  assert.deepEqual(frame.error.details.allowed, OPERATIONS)
})

test('an unknown command line argument is refused with a structured frame', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const result = await controller(['--not-an-option'])
  assert.equal(result.code, 2)
  const frame = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(frame.error.code, 'invalid_params')
  assert.match(frame.error.message, /--not-an-option/)
})

test('a one-shot operation without a project reports project_not_open', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  const result = await controller(['--operation', 'CompilePlc', '--param', 'dry_run=false'])
  assert.equal(result.code, 2)
  const frame = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'project_not_open')
  assert.equal(frame.operation, 'CompilePlc')
})

test('the argument list of repeated --param values becomes an array', async (t) => {
  if (!controllerAvailable) {
    t.skip('the controller executable is not built')
    return
  }

  // ExportBlocks validates its parameters before it needs a project, so a
  // syntactically valid call on a project-less session proves the list reached
  // the argument reader as a list. The failure it reports is the project, not
  // the parameter.
  const result = await controller([
    '--operation', 'ExportBlocks',
    '--param', 'output_dir=C:\\temp\\tia-openness-oneshot',
    '--param', 'block_names=Main',
    '--param', 'block_names=FB1',
  ])
  const frame = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, 'project_not_open', 'the parameter list was accepted and the project was the only problem')
})
