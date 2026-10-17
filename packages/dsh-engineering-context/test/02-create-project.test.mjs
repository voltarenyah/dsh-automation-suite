/**
 * `create_engineering_project`, driven directly with a stand-in context.
 *
 * What is asserted is the contract the model and the workspace depend on: the
 * plan is the default and writes nothing, a real run saves before it exports,
 * TIA's own path is what the result carries, a stopped controller is a state
 * rather than a spawn, every TIA refusal is reported, and the only file this
 * plugin authors on its own (the workspace `.gitignore`) is never rewritten.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  fakeExecWithoutCwd,
  findTool,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  renderedText,
  tempWorkspace,
} from './helpers/harness.mjs'

const { resolveConfig } = await loadConfigModule()
const { TOOL_NAMES, toolDefinitions } = await loadToolsModule()

const TOOL = 'create_engineering_project'

/** What the TIA service reports about the session, by default: a project is open elsewhere. */
function sessionReport(overrides = {}) {
  return {
    running: true,
    projectOpen: true,
    projectName: 'PEI_SinoARP',
    projectPath: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17',
    isModified: false,
    software: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }],
    reason: null,
    ...overrides,
  }
}

/** What the TIA service reports after a rebuild, in the layout it owns. */
function rebuildReport(sourceRoot, overrides = {}) {
  const device = (name, software, counts) => ({
    device: name,
    software,
    directory: join(sourceRoot, name),
    blockCount: counts.blocks + counts.types + counts.tagTables,
    skipped: counts.skipped ?? 0,
    verificationFailed: 0,
    blocks: {
      exported: counts.blocks,
      failed: 0,
      directory: join(sourceRoot, name, 'blocks'),
      manifest: join(sourceRoot, name, 'blocks', '_tia-openness-manifest.json'),
    },
    types: {
      exported: counts.types,
      failed: 0,
      directory: join(sourceRoot, name, 'types'),
      manifest: join(sourceRoot, name, '_tia-openness-manifest.json'),
    },
    tagTables: {
      exported: counts.tagTables,
      failed: 0,
      directory: join(sourceRoot, name, 'tag_tables'),
      manifest: null,
    },
  })
  const report = {
    ok: true,
    error: null,
    summary: 'Rebuilt the source tree.',
    sourceRoot,
    devices: [device('S7-1500', 'PLC_1', { blocks: 2, types: 1, tagTables: 1 })],
    failures: [],
    missingDevices: [],
    ...overrides,
  }
  // The service's *own* success payload: `data.failures` is the very same array as
  // the top-level `failures`. A live session reported one refused object as two
  // because the normalizer counted both; mirroring that shape here is the guard.
  if (report.data === undefined) {
    report.data = {
      sourceRoot,
      devices: report.devices,
      failures: report.failures,
      missingDevices: report.missingDevices,
    }
  }
  return report
}

/** A stand-in `engineeringAccess` service that records every call in order. */
function fakeAccess(options = {}) {
  const calls = []
  const service = {
    async readTiaSession(request = {}) {
      calls.push({ operation: 'readTiaSession', options: request })
      if (options.readThrows !== undefined) throw options.readThrows
      return options.session ?? sessionReport()
    },
    async openProject(projectPath, request = {}) {
      calls.push({ operation: 'openProject', projectPath, options: request })
      if (options.openThrows !== undefined) throw options.openThrows
      if (options.open !== undefined) return options.open
      return {
        ok: true,
        error: null,
        summary: 'Opened the project.',
        data: {
          projectName: 'PEI_SinoARP',
          projectPath,
          requestedPath: projectPath,
          upgraded: false,
          isModified: false,
          plcSoftware: { count: 1, items: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }] },
        },
      }
    },
    async saveProjectAs(directory, request = {}) {
      calls.push({ operation: 'saveProjectAs', directory, options: request })
      if (options.saveThrows !== undefined) throw options.saveThrows
      if (options.save !== undefined) return options.save
      // A real save-as leaves the project on disk where TIA put it.
      await mkdir(directory, { recursive: true })
      return {
        ok: true,
        error: null,
        summary: 'Saved the project.',
        data: {
          requestedSaveAsDir: directory,
          savedAs: join(directory, 'PEI_SinoARP.ap17'),
          projectPath: directory,
          // TIA names the project after the directory it saved into.
          projectName: basename(directory),
        },
      }
    },
    async rebuildSource(sourceRoot, request = {}) {
      calls.push({ operation: 'rebuildSource', sourceRoot, options: request })
      if (options.rebuildThrows !== undefined) throw options.rebuildThrows
      if (options.rebuild !== undefined) return options.rebuild
      // A real rebuild writes the source tree under the root it was given.
      await mkdir(join(sourceRoot, 'S7-1500', 'blocks'), { recursive: true })
      return rebuildReport(sourceRoot)
    },
  }
  return { service, calls }
}

function toolWith(config = {}, services = {}) {
  const { ctx } = createTestContext({ services })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(config), log: ctx.logger })
  return findTool(definitions, TOOL)
}

/** The tool in front of a fake service, plus its call log. */
function setup(options = {}, config = {}) {
  const { service, calls } = fakeAccess(options)
  return { tool: toolWith(config, { engineeringAccess: service }), calls }
}

const operations = (calls) => calls.map((call) => call.operation)

test('this build registers exactly one tool', () => {
  assert.deepEqual([...TOOL_NAMES], [TOOL])
})

test('a composition without the TIA service says so instead of half-creating a project', async (t) => {
  const root = await tempWorkspace(t)
  const outcome = assertEnvelope(await executeTool(toolWith(), {}, fakeExec(root)))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'tia_access_unavailable')
  assert.match(outcome.error.message, /engineeringAccess/u)
  await assert.rejects(stat(join(root, 'tia', basename(root))), 'nothing may be created without a way to reach TIA')
})

test('with nothing open it asks for the project path instead of hunting for one', async (t) => {
  const root = await tempWorkspace(t)

  // Controller running, no project open.
  const nothingOpen = setup({
    session: sessionReport({
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is running but no project is open',
    }),
  })
  const asked = await executeTool(nothingOpen.tool, { dry_run: false }, fakeExec(root))
  assert.equal(asked.ok, false)
  assert.equal(asked.error.code, 'source_project_required')
  assert.match(asked.error.message, /ask the user for the path/u)
  assert.match(asked.error.message, /rather than\s+searching the disk/u)
  assert.deepEqual(operations(nothingOpen.calls), ['readTiaSession'], 'nothing may be opened or saved without a path')

  // Controller not running either: same actionable answer, because opening starts it.
  const stopped = setup({
    session: sessionReport({
      running: false,
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is not running, so no TIA session is open',
    }),
  })
  const alsoAsked = await executeTool(stopped.tool, { dry_run: false }, fakeExec(root))
  assert.equal(alsoAsked.ok, false)
  assert.equal(alsoAsked.error.code, 'source_project_required')
  assert.deepEqual(operations(stopped.calls), ['readTiaSession'])

  await assert.rejects(stat(join(root, 'tia', basename(root))), 'nothing may be created without a project')
})

test('a named project is opened, then saved and exported', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Line1.ap17')
  await makeFile(source, 'project bytes')
  const { tool, calls } = setup({
    session: sessionReport({
      projectOpen: false,
      projectName: null,
      projectPath: null,
      software: [],
      reason: 'the controller is running but no project is open',
    }),
  })

  const outcome = assertEnvelope(
    await executeTool(tool, { source_project: source, dry_run: false }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(operations(calls), ['readTiaSession', 'openProject', 'saveProjectAs', 'rebuildSource'])
  assert.equal(calls[1].projectPath, source)
  assert.equal(calls[1].options.withWindow, true, 'a visible TIA window is the default')
  assert.equal(calls[1].options.allowUpgrade, false, 'upgrading rewrites the project, so it is never implied')
  assert.equal(calls[2].directory, join(root, 'tia', basename(root)))
  assert.equal(calls[3].sourceRoot, join(root, 'source'))
  assert.equal(outcome.data.project.name, 'PEI_SinoARP')
})

test('a different project is never acted on silently', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup() // session: PEI_SinoARP is open elsewhere

  const outcome = await executeTool(
    tool,
    { source_project: join(root, 'Other.ap17'), dry_run: false },
    fakeExec(root),
  )

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'project_already_open')
  assert.deepEqual(operations(calls), ['readTiaSession'], 'TIA refuses a second open anyway; do not try')
  assert.equal(outcome.error.details.requested, join(root, 'Other.ap17'))

  // The same project passed explicitly is fine: it is what is already open.
  const same = await executeTool(
    setup().tool,
    { source_project: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17', dry_run: false },
    fakeExec(root),
  )
  assert.equal(same.ok, true)
})

test('a refused open reports TIA\'s reason and warns about the upgrade switch', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Old.ap15')
  await makeFile(source, 'project bytes')
  const { tool } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: false,
      error: { code: 'project_open_failed', message: 'this project was created by an older version' },
      summary: '',
      data: null,
    },
  })

  const outcome = await executeTool(tool, { source_project: source, dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'open_failed')
  assert.match(outcome.error.message, /older version/u)
  assert.match(outcome.error.message, /allow_upgrade/u)
  assert.match(outcome.error.message, /REWRITES/u)
  assert.equal(outcome.error.details.code, 'project_open_failed')
})

test('an upgrade that TIA did perform is reported loudly', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Old.ap15')
  await makeFile(source, 'project bytes')
  const { tool } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: true,
      error: null,
      summary: 'Opened.',
      data: {
        projectName: 'PEI_SinoARP',
        projectPath: source,
        requestedPath: source,
        upgraded: true,
        isModified: false,
        plcSoftware: { count: 1, items: [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }] },
      },
    },
  })

  const outcome = await executeTool(
    tool,
    { source_project: source, allow_upgrade: true, dry_run: false },
    fakeExec(root),
  )

  assert.equal(outcome.ok, true)
  assert.ok(
    outcome.warnings.some((warning) => /upgraded .* to V17/u.test(warning)),
    'an irreversible rewrite has to be visible in the result',
  )
})

test('the default is a plan: it names the layout and writes nothing at all', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  const outcome = assertEnvelope(await executeTool(tool, {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.deepEqual(operations(calls), ['readTiaSession'], 'a plan asks nothing of TIA beyond the session')
  assert.equal(outcome.data.plan.name, 'PEI_SinoARP')
  assert.equal(outcome.data.plan.projectDirectory.port, `tia/${basename(root)}`)
  assert.equal(outcome.data.plan.sourceRoot.port, 'source')
  assert.equal(outcome.data.plan.skipSave, false)
  assert.deepEqual(outcome.data.plan.devices, [{ device: 'S7-1500', software: 'PLC_1', blockCount: 3 }])

  await assert.rejects(stat(join(root, 'tia', basename(root))), 'a dry run must not create the project directory')
  await assert.rejects(stat(join(root, 'source')), 'a dry run must not create the source tree')
  await assert.rejects(stat(join(root, '.gitignore')), 'a dry run must not touch the workspace .gitignore')
  assert.match(renderedText(tool, {}, outcome), /Dry run/u)
})

test('dry_run=false saves into tia/ and then rebuilds into source/, in that order', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, false)
  assert.deepEqual(operations(calls), ['readTiaSession', 'saveProjectAs', 'rebuildSource'])
  assert.equal(calls[1].directory, join(root, 'tia', basename(root)))
  assert.equal(calls[2].sourceRoot, join(root, 'source'))
  assert.equal(calls[2].options.overwrite, false)

  // TIA's own path is what the result carries, never the requested directory.
  assert.equal(outcome.data.project.savedAs, join(root, 'tia', basename(root), 'PEI_SinoARP.ap17'))
  // The payload describes the disk after the run, not what the plan found before it.
  assert.equal(outcome.data.project.directory.kind, 'directory')
  assert.equal(outcome.data.project.sourceRoot.kind, 'directory')
  // Planned and written are different numbers, and the plan's counts are the ones
  // that include skipped files: all four planned objects were really written here.
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 4, skipped: 0, refused: 0, verificationFailed: 0 })
  assert.equal(outcome.data.rebuild.nothingWritten, false)
  assert.ok(
    outcome.warnings.some((warning) => /TIA named the workspace copy/u.test(warning)),
    'the rename TIA performs is reported',
  )
  assert.equal(outcome.data.ignore.action, 'created')
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^tia\/$/mu)
  assert.match(outcome.summary, /Saved PEI_SinoARP into tia\//u)

  // The index is the workspace-level entry point: it says which project the tree
  // belongs to (the controller writes one manifest per device, not per project).
  assert.equal(outcome.data.index.action, 'created')
  const index = JSON.parse(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'))
  assert.equal(index.project.name, 'PEI_SinoARP')
  assert.equal(index.project.directory, `tia/${basename(root)}`)
  assert.equal(index.project.sourceRoot, 'source')
  assert.equal(index.devices.length, 1)
  assert.equal(index.devices[0].device, 'S7-1500')
  assert.match(index.devices[0].manifest, /_tia-openness-manifest\.json$/u)
  assert.deepEqual(index.totals, { planned: 4, written: 4, skipped: 0, refused: 0, verificationFailed: 0 })
})

test('overwrite is passed through to the export', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup()

  await executeTool(tool, { dry_run: false, overwrite: true }, fakeExec(root))

  assert.equal(calls[2].options.overwrite, true)
})

test('a refused save stops there: the source tree is not touched and no ignore rule is written', async (t) => {
  const root = await tempWorkspace(t)
  const { tool, calls } = setup({
    save: {
      ok: false,
      error: { code: 'project_exists', message: 'a project named PEI_SinoARP already exists in that directory' },
      summary: '',
      data: null,
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'save_failed')
  assert.match(outcome.error.message, /already exists/u)
  assert.equal(outcome.error.details.code, 'project_exists')
  assert.deepEqual(operations(calls), ['readTiaSession', 'saveProjectAs'])
  await assert.rejects(stat(join(root, '.gitignore')), 'the ignore rule belongs to a project that is really there')
})

test('a failed rebuild says the project is saved, so a retry only redoes the export', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: {
      ok: false,
      error: { code: 'controller_timeout', message: 'the controller did not answer in time' },
      summary: '',
      sourceRoot: join(root, 'source'),
      devices: [],
      failures: [{ device: 'S7-1500', category: 'blocks', name: 'OB1', code: 'export_failed', message: 'boom' }],
      missingDevices: [],
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'rebuild_failed')
  assert.match(outcome.error.message, /only redoes the export/u)
  assert.equal(outcome.error.details.code, 'controller_timeout')
  assert.equal(outcome.error.details.failures.length, 1)
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^tia\/$/mu, 'the saved half keeps its ignore rule')
})

test('objects TIA refuses are reported per object and do not fail the call', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: rebuildReport(join(root, 'source'), {
      summary: 'Rebuilt 1 device; 1 object refused.',
      failures: [
        { device: 'S7-1500', category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' },
      ],
    }),
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.rebuild.failures.length, 1)
  // One of the four planned objects was refused, so three reached the disk.
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 3, skipped: 0, refused: 1, verificationFailed: 0 })
  assert.ok(
    outcome.warnings.some((warning) => /refused/u.test(warning)),
    'a refusal is material and must be a warning',
  )
  assert.match(renderedText(tool, {}, outcome), /Refused: S7-1500\/blocks\/FOB_SAFETY/u)
})

test('a run where every file already exists is reported as such, not as a TIA refusal', async (t) => {
  const root = await tempWorkspace(t)
  // The project is already in the workspace, so this is the plain "refresh the
  // tree" path — the run that used to come back as a hard failure.
  const inside = join(root, 'tia', basename(root), 'PEI_SinoARP.ap17')
  await makeFile(inside, 'project bytes')
  const sourceRoot = join(root, 'source')

  const { tool } = setup({
    session: sessionReport({ projectPath: inside }),
    rebuild: {
      ok: false,
      error: { code: 'export_failed', message: 'No object could be exported: Openness refused all 4 object(s).' },
      summary: '',
      sourceRoot,
      devices: [],
      failures: [],
      missingDevices: [],
      // The controller's partial payload: nothing written, four files skipped,
      // nothing refused — yet it reports `export_failed`.
      data: {
        counts: { blocks: 0, types: 3, tagTables: 1 },
        summary: { exported: 0, skipped: 4, failed: 0, verificationFailed: 0 },
      },
    },
  })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true, 'nothing was refused: the files were simply already there')
  assert.equal(outcome.error, null)
  assert.equal(outcome.dryRun, false)
  assert.deepEqual(outcome.data.rebuild.totals, { planned: 4, written: 0, skipped: 4, refused: 0, verificationFailed: 0 })
  assert.equal(outcome.data.rebuild.nothingWritten, true)
  // The controller's misleading "refused all" wording must not reach the model.
  assert.doesNotMatch(outcome.summary, /refus/iu)
  assert.match(outcome.summary, /already present/u)
  assert.match(outcome.summary, /overwrite=true/u)
  assert.ok(
    outcome.warnings.some((warning) => /may be stale/u.test(warning)),
    'the caller has to be told the tree was left exactly as it was',
  )
  assert.ok(
    outcome.warnings.some((warning) => /not examined at all/u.test(warning)),
    'the plugin stops at the first device it cannot finish, so the ones after it are named',
  )
})

test('a run that refused objects stays a failure even when it also skipped some', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup({
    rebuild: {
      ok: false,
      error: { code: 'export_failed', message: 'One object was refused.' },
      summary: '',
      sourceRoot: join(root, 'source'),
      devices: [],
      failures: [],
      missingDevices: [],
      data: {
        counts: { blocks: 2, types: 1, tagTables: 0 },
        summary: { exported: 1, skipped: 1, failed: 1, verificationFailed: 0 },
        failures: [{ category: 'blocks', name: 'FOB_SAFETY', code: 'export_failed', message: 'not permitted' }],
      },
    },
  })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'rebuild_failed')
  assert.match(outcome.error.message, /only redoes the export/u)
  // How far it got is part of the failure, not left to be guessed.
  assert.deepEqual(outcome.error.details.totals, { planned: 3, written: 1, skipped: 1, refused: 1, verificationFailed: 0 })
})

test('a project already inside the workspace skips the save-as and only refreshes the tree', async (t) => {
  const root = await tempWorkspace(t)
  const inside = join(root, 'tia', basename(root), 'PEI_SinoARP.ap17')
  await makeFile(inside, 'project bytes')
  const { tool, calls } = setup({ session: sessionReport({ projectPath: inside }) })

  const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.project.skipSave, true)
  assert.deepEqual(operations(calls), ['readTiaSession', 'rebuildSource'], 're-running must not save the project again')
})

test('an existing source tree is announced rather than silently skipped', async (t) => {
  const root = await tempWorkspace(t)
  await mkdir(join(root, 'source'), { recursive: true })
  const { tool } = setup()

  const outcome = await executeTool(tool, {}, fakeExec(root))

  assert.ok(
    outcome.warnings.some((warning) => /already exists/u.test(warning)),
    'the caller should know that existing files will be skipped',
  )
})

test('the ignore rule is created, appended or left alone — the file is never rewritten', async (t) => {
  // Missing file: created with the rule.
  const fresh = await tempWorkspace(t)
  await executeTool(setup().tool, { dry_run: false }, fakeExec(fresh))
  const created = await readFile(join(fresh, '.gitignore'), 'utf8')
  assert.match(created, /^tia\/$/mu)

  // Existing file without the rule: the user's lines survive, the rule is appended.
  const existing = await tempWorkspace(t)
  await makeFile(join(existing, '.gitignore'), 'node_modules/\n*.log\n')
  await executeTool(setup().tool, { dry_run: false }, fakeExec(existing))
  const appended = await readFile(join(existing, '.gitignore'), 'utf8')
  assert.match(appended, /^node_modules\/$/mu)
  assert.match(appended, /^\*\.log$/mu)
  assert.match(appended, /^tia\/$/mu)

  // Running twice must not append the rule twice.
  await executeTool(setup().tool, { dry_run: false }, fakeExec(existing))
  const twice = await readFile(join(existing, '.gitignore'), 'utf8')
  assert.equal(twice.match(/^tia\/$/gmu).length, 1)
})

test('the target dirs do not depend on the project name, which is only the recorded identity', async (t) => {
  const root = await tempWorkspace(t)

  // A name with characters a filesystem rejects changes nothing about the targets.
  const odd = await executeTool(setup({ session: sessionReport({ projectName: 'A/B:C' }) }).tool, {}, fakeExec(root))
  assert.equal(odd.data.plan.projectDirectory.port, `tia/${basename(root)}`)
  assert.equal(odd.data.plan.sourceRoot.port, 'source')

  // A name is derived from the project path when TIA reports none, and the tool
  // refuses to invent one when there is nothing to derive from.
  const fallback = await executeTool(
    setup({ session: sessionReport({ projectName: null, projectPath: 'C:\\TIA\\SinoARP\\tia.ap17' }) }).tool,
    {},
    fakeExec(root),
  )
  assert.equal(fallback.ok, true)
  assert.equal(fallback.data.plan.name, 'tia')

  const nothing = await executeTool(
    setup({ session: sessionReport({ projectName: null, projectPath: null }) }).tool,
    {},
    fakeExec(root),
  )
  assert.equal(nothing.ok, false)
  assert.equal(nothing.error.code, 'project_name_unavailable')
})

test('one workspace manages one project: another project\'s tree is refused', async (t) => {
  const root = await tempWorkspace(t)
  // What an earlier run for a different project left behind.
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({ schemaVersion: 1, project: { name: 'OTHER_PROJECT' } }),
  )
  const { tool, calls } = setup()

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'source_belongs_to_another_project')
  assert.match(outcome.error.message, /OTHER_PROJECT/u)
  assert.equal(outcome.error.details.current, 'PEI_SinoARP')
  assert.deepEqual(operations(calls), ['readTiaSession'], 'nothing is written before the check')

  // The same project again is fine, and an unreadable index is only a warning.
  await makeFile(join(root, 'source', '_dsh-engineering-context.json'), '{ not json')
  const corrupted = await executeTool(setup().tool, { dry_run: false }, fakeExec(root))
  assert.equal(corrupted.ok, true)
  assert.ok(
    corrupted.warnings.some((warning) => /could not be read/u.test(warning)),
    'an index that cannot be read is reported, not ignored',
  )
})

test('TIA renaming the saved copy does not make the tool reject its own tree', async (t) => {
  const root = await tempWorkspace(t)
  // What a live session showed: the copy is saved into `tia/`, so TIA names the
  // project `tia` while the index still records the source project's name.
  const copy = join(root, 'tia', basename(root), ` ${basename(root)}.ap17`)
  await makeFile(copy, 'project bytes')
  await makeFile(
    join(root, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: 'PEI_SinoARP_SWT2', path: 'C:\\src\\PEI_SinoARP_SWT2.ap17', savedAs: copy },
    }),
  )
  const { tool } = setup({ session: sessionReport({ projectName: basename(root), projectPath: copy }) })

  const outcome = await executeTool(tool, { dry_run: false }, fakeExec(root))

  assert.equal(outcome.ok, true, 'the recorded path identifies the project, not the name TIA rewrote')
  assert.ok(
    outcome.warnings.some((warning) => warning.includes(`TIA reports ${basename(root)} for the same project file`)),
    'the rename is reported rather than hidden',
  )
  const index = JSON.parse(await readFile(join(root, 'source', '_dsh-engineering-context.json'), 'utf8'))
  assert.equal(index.project.name, basename(root), 'the index is refreshed with the name TIA now reports')
})

test('acting on the project TIA happens to have open is flagged, not assumed', async (t) => {
  const root = await tempWorkspace(t)
  const { tool } = setup() // a project is open; this call names none

  const outcome = await executeTool(tool, {}, fakeExec(root))

  assert.equal(outcome.ok, true)
  assert.ok(
    outcome.warnings.some((warning) => /Nobody named a project in this call/u.test(warning)),
    'the model has to be told it is acting on a project nobody named (the failure mode of session-2cfc6894)',
  )
  assert.match(outcome.details[0], /NOBODY named this project/u)
  // Naming the project removes the flag: the caller chose it.
  const named = await executeTool(
    setup().tool,
    { source_project: 'C:\\TIA\\SinoARP\\PEI_SinoARP.ap17' },
    fakeExec(root),
  )
  assert.equal(
    named.warnings.some((warning) => /Nobody named a project/u.test(warning)),
    false,
  )
})

test('a plan opens nothing at all, even when given a source project', async (t) => {
  const root = await tempWorkspace(t)
  const source = join(root, 'Line1.ap17')
  await makeFile(source, 'project bytes')
  const { tool, calls } = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
  })

  const outcome = assertEnvelope(await executeTool(tool, { source_project: source, dry_run: true }, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.deepEqual(operations(calls), ['readTiaSession'], 'planning must not open anything (exactly this broke a live session)')
  assert.match(outcome.summary, /would open/u)
  assert.match(outcome.details[0], /will open/u)
  await assert.rejects(stat(join(root, 'tia')), 'a plan creates nothing')
})

test('a project someone else opened stops the call with one instruction', async (t) => {
  const root = await tempWorkspace(t)
  const named = join(root, 'Line1.ap17')
  await makeFile(named, 'project bytes')

  // (a) the controller can see the other project, so the tool refuses before asking TIA.
  const seen = setup() // session: PEI_SinoARP is open elsewhere
  const refused = await executeTool(seen.tool, { source_project: named, dry_run: false }, fakeExec(root))
  assert.equal(refused.error.code, 'project_already_open')
  assert.match(refused.error.message, /close that project in TIA Portal/u)
  assert.match(refused.error.message, /call this tool again once it is closed/u)
  assert.deepEqual(operations(seen.calls), ['readTiaSession'], 'no open attempt, no investigation')

  // (b) the controller cannot see it and TIA refuses: same code, same instruction.
  const hidden = setup({
    session: sessionReport({ projectOpen: false, projectName: null, projectPath: null, software: [] }),
    open: {
      ok: false,
      error: { code: 'project_already_open', message: 'A project is already open (x). Close it first with CloseProject.' },
      summary: '',
      data: null,
    },
  })
  const bounced = await executeTool(hidden.tool, { source_project: named, dry_run: false }, fakeExec(root))
  assert.equal(bounced.error.code, 'project_already_open', 'not a generic open_failed: the answer is "close it"')
  assert.match(bounced.error.message, /Tell the user to close the project that is open/u)
  assert.match(bounced.error.message, /Do not investigate process/u)
  assert.deepEqual(operations(hidden.calls), ['readTiaSession', 'openProject'])
})

test('a transport failure is reported as data, and the workspace is left alone', async (t) => {
  const root = await tempWorkspace(t)

  const unreadable = await executeTool(setup({ readThrows: new Error('controller_not_found') }).tool, {}, fakeExec(root))
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.code, 'tia_unreachable')
  assert.match(unreadable.error.message, /controller_not_found/u)

  const { tool, calls } = setup({ saveThrows: new Error('controller_timeout') })
  const unsaved = await executeTool(tool, { dry_run: false }, fakeExec(root))
  assert.equal(unsaved.ok, false)
  assert.equal(unsaved.error.code, 'tia_unreachable')
  assert.deepEqual(operations(calls), ['readTiaSession', 'saveProjectAs'])
  await assert.rejects(stat(join(root, '.gitignore')))
})

test('a session without a working directory fails closed', async () => {
  const { tool } = setup()

  for (const exec of [fakeExec(undefined), fakeExecWithoutCwd()]) {
    const outcome = assertEnvelope(await executeTool(tool, { dry_run: false }, exec))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'scope_unavailable')
    assert.equal(outcome.scope, null)
  }
})
