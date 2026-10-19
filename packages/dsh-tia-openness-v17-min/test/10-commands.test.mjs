/**
 * Slash-command tests.
 *
 * These drive the `/tia-…` handlers the way the host command plane does: a bare
 * `rawInput` line, the receiving agent's session cwd, and a recording controller
 * stub. They pin the two contracts a command card depends on — the registration
 * metadata (names, hints) and the response text's **first line**, which is the
 * only thing visible while the card is collapsed.
 *
 * The real `@deepseek-ai/dsh-commands` registry is not mounted here: executing a
 * command through it needs a session log, a live agent and the Remote transport,
 * none of which these bodies touch. Registration metadata and handler behavior
 * are what this file can prove; the live profile verification covers the rest.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createTestContext,
  loadCommandsEntry,
  loadCommandsModule,
} from './helpers/harness.mjs'

const COMMAND_NAMES = ['tia-open', 'tia-save', 'tia-compile', 'tia-close', 'tia-info', 'tia-find', 'tia-status']

/** The controller status the stub reports; it must never require a request. */
const READY_STATUS = {
  state: 'ready',
  exePath: 'C:\\plugin\\controller\\bin\\TiaOpennessV17Min.Controller.exe',
  exeExists: true,
  pid: 4242,
  startedAt: '2026-10-19T14:00:00.000Z',
  requestsServed: 7,
  restarts: 0,
  queueDepth: 0,
  inflightOperation: null,
  lastError: null,
  ready: {
    openness: { available: true, assemblyPath: 'C:\\Siemens\\Openness\\Siemens.Engineering.dll', fileVersion: '17.0.0.0' },
    opennessUserGroup: { group: 'Siemens TIA Openness', isMember: true },
  },
  stderrTail: ['a stderr line'],
  unexpectedOutput: [],
}

/**
 * A recording controller: every operation is captured, and the reply function
 * decides the frame so a test can shape the data a headline reads.
 */
function recordingController(reply) {
  const calls = []
  const dependencies = {
    request: async (operation, params, options) => {
      calls.push({ operation, params, options })
      return reply === undefined ? { ok: true, dryRun: false, durationMs: 12, data: {} } : reply(operation, params)
    },
    status: () => READY_STATUS,
    verbose: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { calls, dependencies }
}

/** One invocation exactly as `CommandRuntime.execute` hands it to a handler. */
function invocation(cwd, rawInput = '') {
  return {
    agent: { session: { header: { cwd } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

/** Registers the commands on a fresh harness and returns the lookup helper. */
function register(dependencies) {
  const harness = createTestContext()
  // The registration lives in one effect, so the harness owns its disposer.
  registerCommands(harness.ctx, dependencies)
  const find = (name) => {
    const definition = harness.commands.find((candidate) => candidate.name === name)
    if (definition === undefined) throw new Error(`/${name} was not registered`)
    return definition
  }
  return { harness, find }
}

const { registerCommands } = await loadCommandsModule()

async function temporaryWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tia-commands-'))
  t.after(async () => {
    // A directory this test created; no junction is involved.
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test('registers the seven /tia- commands with menu metadata', async () => {
  const { harness } = register(recordingController().dependencies)
  assert.deepEqual(
    harness.commands.map((definition) => definition.name),
    COMMAND_NAMES,
  )
  for (const definition of harness.commands) {
    assert.match(definition.name, /^[a-z][a-z0-9-]*$/)
    assert.ok(definition.description.length > 0, `${definition.name} needs a description`)
  }
  for (const name of ['tia-close', 'tia-info', 'tia-find']) {
    const definition = harness.commands.find((candidate) => candidate.name === name)
    assert.ok(definition.input?.hint.length > 0, `/${name} advertises an input hint`)
  }
  for (const name of ['tia-open', 'tia-save', 'tia-compile', 'tia-status']) {
    const definition = harness.commands.find((candidate) => candidate.name === name)
    assert.equal(definition.input, undefined, `/${name} runs directly, without an input step`)
  }
})

test('unloading the commands row unregisters every command', async () => {
  const { harness } = register(recordingController().dependencies)
  assert.equal(harness.commands.length, COMMAND_NAMES.length)
  await harness.unload()
  assert.equal(harness.commands.length, 0)
})

test('/tia-open opens the indexed workspace project in a visible TIA Portal', async (t) => {
  const workspace = await temporaryWorkspace(t)
  const project = join(workspace, 'tia', 'ws', 'ws.ap17')
  await mkdir(join(workspace, 'tia', 'ws'), { recursive: true })
  await writeFile(project, '')
  await mkdir(join(workspace, 'source'), { recursive: true })
  await writeFile(
    join(workspace, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({ schemaVersion: 1, project: { name: 'ws', savedAs: project, path: 'C:\\source\\ws.ap17' } }),
  )

  const controller = recordingController(() => ({
    ok: true,
    dryRun: false,
    durationMs: 8300,
    data: { projectName: 'ws', withUserInterface: true, plcSoftware: { count: 1, items: [{ blockCount: 1155 }] } },
  }))
  const { find } = register(controller.dependencies)

  const result = await find('tia-open').handler(invocation(workspace))
  assert.equal(result.kind, 'success')
  assert.equal(controller.calls.length, 1)
  assert.equal(controller.calls[0].operation, 'OpenProject')
  assert.equal(controller.calls[0].params.project_path, project)
  assert.equal(controller.calls[0].params.with_window, true)
  assert.equal(controller.calls[0].params.allow_upgrade, undefined)
  assert.equal(result.text.split('\n')[0], 'Opened ws — 1 PLC software, 1155 block(s), visible TIA Portal')
})

test('/tia-open scans tia/ when the index is missing and reports ambiguity', async (t) => {
  const workspace = await temporaryWorkspace(t)
  await mkdir(join(workspace, 'tia', 'only'), { recursive: true })
  const project = join(workspace, 'tia', 'only', 'only.ap17')
  await writeFile(project, '')

  const controller = recordingController()
  const { find } = register(controller.dependencies)
  const result = await find('tia-open').handler(invocation(workspace))
  assert.equal(result.kind, 'success')
  assert.equal(controller.calls[0].params.project_path, project)

  await mkdir(join(workspace, 'tia', 'second'), { recursive: true })
  await writeFile(join(workspace, 'tia', 'second', 'second.ap17'), '')
  const ambiguous = await find('tia-open').handler(invocation(workspace))
  assert.equal(ambiguous.kind, 'error')
  assert.match(ambiguous.text, /Several TIA projects/)
  assert.match(ambiguous.text, /only\.ap17/)
  assert.match(ambiguous.text, /second\.ap17/)
})

test('/tia-open reports a workspace without a project instead of guessing', async (t) => {
  const workspace = await temporaryWorkspace(t)
  const controller = recordingController()
  const { find } = register(controller.dependencies)
  const result = await find('tia-open').handler(invocation(workspace))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /No TIA project under/)
  assert.equal(controller.calls.length, 0)
})

test('/tia-open refuses a path argument', async () => {
  const controller = recordingController()
  const { find } = register(controller.dependencies)
  const result = await find('tia-open').handler(invocation('C:\\work', 'C:\\other\\x.ap17'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /takes no arguments/)
  assert.equal(controller.calls.length, 0)
})

test('/tia-close saves by default, discards with --discard and reports with --dry', async () => {
  const controller = recordingController(() => ({
    ok: true,
    dryRun: false,
    durationMs: 40,
    data: { projectName: 'ws', saved: true, closed: true, portalClosed: false },
  }))
  const { find } = register(controller.dependencies)
  const close = find('tia-close')

  const plain = await close.handler(invocation('C:\\work', ''))
  assert.equal(plain.kind, 'success')
  assert.deepEqual(controller.calls[0].params, { save: true, close_portal: false, dry_run: false })
  assert.equal(plain.text.split('\n')[0], 'Closed ws — saved')

  const discard = await close.handler(invocation('C:\\work', '--discard'))
  assert.equal(discard.kind, 'success')
  assert.deepEqual(controller.calls[1].params, { save: false, close_portal: false, dry_run: false })

  const dry = await close.handler(invocation('C:\\work', '--dry'))
  assert.equal(dry.kind, 'success')
  assert.deepEqual(controller.calls[2].params, { save: true, close_portal: false, dry_run: true })

  const contradictory = await close.handler(invocation('C:\\work', '--discard --save'))
  assert.equal(contradictory.kind, 'error')
  assert.match(contradictory.text, /contradict/)
  assert.equal(controller.calls.length, 3)
})

test('/tia-save and /tia-compile send only their documented parameters', async () => {
  const controller = recordingController((operation) => ({
    ok: true,
    dryRun: false,
    durationMs: 120,
    data:
      operation === 'SaveProject'
        ? { projectName: 'ws', saved: true, isModifiedBeforeSave: true }
        : { device: 'Sino_PEI', state: 'Success', errorCount: 0, warningCount: 2, messageCount: 2 },
  }))
  const { find } = register(controller.dependencies)

  const saved = await find('tia-save').handler(invocation('C:\\work'))
  assert.equal(saved.kind, 'success')
  assert.equal(controller.calls[0].operation, 'SaveProject')
  assert.deepEqual(controller.calls[0].params, {})
  assert.ok(controller.calls[0].options.signal instanceof AbortSignal, 'the UI cancellation signal reaches the controller')
  assert.equal(saved.text.split('\n')[0], 'Saved ws in place (modified before save: yes)')

  const compiled = await find('tia-compile').handler(invocation('C:\\work'))
  assert.equal(compiled.kind, 'success')
  assert.equal(controller.calls[1].operation, 'CompilePlc')
  assert.deepEqual(controller.calls[1].params, { max_messages: 50 })
  assert.equal(compiled.text.split('\n')[0], 'Compile Sino_PEI: no errors (2 warning(s))')
})

test('/tia-info defaults to a compact section set and rejects unknown sections', async () => {
  const controller = recordingController(() => ({
    ok: true,
    dryRun: false,
    durationMs: 30,
    data: {
      attributes: { name: 'ws', isModified: true },
      software: { count: 1, items: [{ device: 'Sino_PEI', software: 'Sino_PEI', blockCount: 1155 }] },
    },
  }))
  const { find } = register(controller.dependencies)
  const info = find('tia-info')

  const compact = await info.handler(invocation('C:\\work', ''))
  assert.equal(compact.kind, 'success')
  assert.deepEqual(controller.calls[0].params.sections, ['attributes', 'comment', 'software'])
  assert.equal(compact.text.split('\n')[0], 'Project ws — 1 PLC software, modified')

  const explicit = await info.handler(invocation('C:\\work', 'devices history'))
  assert.equal(explicit.kind, 'success')
  assert.deepEqual(controller.calls[1].params.sections, ['devices', 'history'])

  const unknown = await info.handler(invocation('C:\\work', 'bogus'))
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown section "bogus"/)
  assert.equal(controller.calls.length, 2)
})

test('/tia-find maps flags to categories and folds the filter into one name_filter', async () => {
  const controller = recordingController(() => ({
    ok: true,
    dryRun: false,
    durationMs: 80,
    data: { device: 'Sino_PEI', counts: { blocks: 3, types: 0, tagTables: 1, tags: 0, constants: 0 } },
  }))
  const { find } = register(controller.dependencies)
  const search = find('tia-find')

  const filtered = await search.handler(invocation('C:\\work', 'Motor 1'))
  assert.equal(filtered.kind, 'success')
  assert.equal(controller.calls[0].operation, 'ListPlcObjects')
  assert.deepEqual(controller.calls[0].params.categories, ['blocks', 'types', 'tag_tables'])
  assert.equal(controller.calls[0].params.name_filter, 'Motor 1')
  assert.equal(controller.calls[0].params.max_items, 50)
  assert.equal(controller.calls[0].params.include_fingerprints, false)
  assert.equal(filtered.text.split('\n')[0], '4 object(s) matching "Motor 1" — 3 blocks, 1 tagTables')

  const narrowed = await search.handler(invocation('C:\\work', '--tables --fp'))
  assert.equal(narrowed.kind, 'success')
  assert.deepEqual(controller.calls[1].params.categories, ['tag_tables'])
  assert.equal(controller.calls[1].params.include_fingerprints, true)
  assert.equal(controller.calls[1].params.name_filter, undefined)

  const unknown = await search.handler(invocation('C:\\work', '--bogus'))
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown option --bogus/)
  assert.equal(controller.calls.length, 2)
})

test('/tia-status never sends a controller request', async () => {
  const controller = recordingController()
  const { find } = register(controller.dependencies)
  const result = await find('tia-status').handler(invocation('C:\\work'))
  assert.equal(result.kind, 'success')
  assert.equal(controller.calls.length, 0)
  assert.match(result.text, /Controller state: ready/)
  assert.match(result.text, /"Siemens TIA Openness" membership: yes/)
  assert.match(result.text, /Openness: available at/)
})

test('a failed operation settles as an error card with the structured reason', async () => {
  const controller = recordingController(() => ({
    ok: false,
    dryRun: false,
    durationMs: 3,
    error: { code: 'project_not_open', message: 'No project is open in TIA Portal.', details: { hint: 'Call /tia-open first.' } },
  }))
  const { find } = register(controller.dependencies)
  const result = await find('tia-save').handler(invocation('C:\\work'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /SaveProject FAILED/)
  assert.match(result.text, /project_not_open/)
  assert.match(result.text, /Call \/tia-open first\./)
})

test('the /commands row injects commands and the runtime seam and registers the same names', async () => {
  const entry = await loadCommandsEntry()
  assert.equal(entry.name, 'tia-openness-v17-min-commands')
  assert.deepEqual(entry.inject, ['commands', 'tiaOpennessRuntime'])

  const harness = createTestContext()
  const runtime = {
    request: async () => ({ ok: true, dryRun: false, durationMs: 1, data: {} }),
    status: () => READY_STATUS,
    verbose: false,
  }
  harness.services.set('tiaOpennessRuntime', runtime)

  entry.apply(harness.ctx)
  assert.deepEqual(
    harness.commands.map((definition) => definition.name),
    COMMAND_NAMES,
  )
  const log = harness.logs.find(([, , message]) => message.includes('slash commands'))
  assert.ok(log, 'the row logs what it registered')
})
