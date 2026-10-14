/**
 * The three tool bodies, driven directly with a stand-in context.
 *
 * What is asserted is the contract the model depends on: which scope a call
 * resolves to, the dry-run defaults (adding information is immediate, removing or
 * overwriting it needs an explicit `dry_run: false`), that an out-of-workspace
 * path is refused, that the source project is never modified, and that two
 * workspaces do not see each other's projects.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
const { toolDefinitions } = await loadToolsModule()

const config = resolveConfig()

async function setup(options = {}) {
  const { ctx, definitions, logs } = createTestContext(options)
  const tools = toolDefinitions({ ctx, config, log: ctx.logger })
  return { ctx, logs, tools }
}

const status = (tools) => findTool(tools, 'eng_status')
const project = (tools) => findTool(tools, 'eng_project')
const scope = (tools) => findTool(tools, 'eng_scope')

test('eng_status resolves the scope from the session working directory', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  const outcome = assertEnvelope(await executeTool(status(tools), {}, fakeExec(root)))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.scope.workspace.path, root)
  assert.equal(outcome.scope.workspace.registered, false)
  assert.equal(outcome.scope.project, null)
  assert.equal(outcome.scope.version.kind, 'none')
  assert.equal(outcome.data.registry.status, 'missing')
  assert.match(renderedText(status(tools), {}, outcome), /eng_status:/u)
})

test('eng_status reports the host workspace identity when the registry knows the path', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup({
    workspaceRegistry: {
      resolveByPath: async (path) => (path === root ? { path, title: 'PEI Workspace' } : undefined),
    },
  })
  const outcome = await executeTool(status(tools), {}, fakeExec(root))
  assert.equal(outcome.scope.workspace.registered, true)
  assert.equal(outcome.scope.workspace.title, 'PEI Workspace')
  assert.equal(outcome.data.capabilities.hostWorkspaceRegistry, true)
})

test('a missing session working directory fails closed with scope_unavailable', async () => {
  const { tools } = await setup()
  const noAgent = await executeTool(status(tools), {}, fakeExec(undefined))
  assert.equal(noAgent.ok, false)
  assert.equal(noAgent.error.code, 'scope_unavailable')
  assert.equal(noAgent.scope, null)

  const noCwd = await executeTool(status(tools), {}, fakeExecWithoutCwd())
  assert.equal(noCwd.ok, false)
  assert.equal(noCwd.error.code, 'scope_unavailable')
})

test('register records a project and selects it, inside the workspace', async (t) => {
  const root = await tempWorkspace(t)
  const source = await makeFile(join(root, '..', `src-${Date.now()}.ap17`), 'project-bytes')
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(source, { force: true }))
  })
  const { tools } = await setup()

  const outcome = assertEnvelope(
    await executeTool(
      project(tools),
      { action: 'register', project_id: 'pei', title: 'PEI', source_path: source },
      fakeExec(root),
    ),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, false)

  const document = JSON.parse(await readFile(join(root, '_dsh-eng', 'projects.json'), 'utf8'))
  assert.equal(document.workspacePath, root)
  assert.equal(document.current, 'pei')
  assert.equal(document.projects.length, 1)
  assert.equal(document.projects[0].id, 'pei')
  assert.equal(document.projects[0].work, 'projects/pei/work/' + source.split(/[\\/]/u).pop())
  assert.equal(document.projects[0].export, 'projects/pei/export')
  assert.equal(document.projects[0].adoptedAt, null)

  const after = await executeTool(status(tools), {}, fakeExec(root))
  assert.equal(after.scope.project.id, 'pei')
  assert.equal(after.scope.projectCount, 1)
})

test('register derives a unique id when the requested one is taken', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei' }, fakeExec(root))
  const second = await executeTool(project(tools), { action: 'register', project_id: 'pei' }, fakeExec(root))
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'project_already_registered')

  const derived = await executeTool(project(tools), { action: 'register', title: 'PEI' }, fakeExec(root))
  assert.equal(derived.ok, true)
  assert.equal(derived.data.project.id, 'pei-2')
})

test('register refuses a working copy outside the workspace', async (t) => {
  const root = await tempWorkspace(t)
  const outside = await tempWorkspace(t)
  const { tools } = await setup()
  const outcome = await executeTool(
    project(tools),
    { action: 'register', project_id: 'pei', work_path: join(outside, 'tia.ap17') },
    fakeExec(root),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'path_outside_workspace')
  assert.match(outcome.error.message, /must stay inside the workspace root/u)
})

test('register refuses a source that does not exist, and an unusable project_id', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  const missing = await executeTool(
    project(tools),
    { action: 'register', project_id: 'pei', source_path: join(root, 'nope.ap17') },
    fakeExec(root),
  )
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'source_not_found')

  const badId = await executeTool(
    project(tools),
    { action: 'register', project_id: '../escape' },
    fakeExec(root),
  )
  assert.equal(badId.ok, false)
  assert.equal(badId.error.code, 'invalid_argument')
})

test('adopt plans by default and only copies when told to', async (t) => {
  const root = await tempWorkspace(t)
  const sourceDir = await tempWorkspace(t)
  const source = await makeFile(join(sourceDir, 'tia.ap17'), 'project-bytes')
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei', source_path: source }, fakeExec(root))

  const plan = await executeTool(project(tools), { action: 'adopt' }, fakeExec(root))
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  const target = join(root, 'projects', 'pei', 'work', 'tia.ap17')
  await assert.rejects(stat(target), 'adopt must not write during a dry run')

  const done = await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))
  assert.equal(done.ok, true)
  assert.equal(done.dryRun, false)
  assert.equal(await readFile(target, 'utf8'), 'project-bytes')
  // The source is provenance: adopted, never modified.
  assert.equal(await readFile(source, 'utf8'), 'project-bytes')

  const document = JSON.parse(await readFile(join(root, '_dsh-eng', 'projects.json'), 'utf8'))
  assert.notEqual(document.projects[0].adoptedAt, null)
})

test('adopt refuses to clobber an existing working copy without overwrite', async (t) => {
  const root = await tempWorkspace(t)
  const sourceDir = await tempWorkspace(t)
  const source = await makeFile(join(sourceDir, 'tia.ap17'), 'first')
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei', source_path: source }, fakeExec(root))
  await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))

  const again = await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'target_exists')

  const forced = await executeTool(project(tools), { action: 'adopt', dry_run: false, overwrite: true }, fakeExec(root))
  assert.equal(forced.ok, true)
})

test('adopt without a recorded source explains itself instead of guessing', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei' }, fakeExec(root))
  const outcome = await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_argument')
  assert.match(outcome.error.message, /no recorded source path/u)
})

test('forget defaults to a plan, then unregisters without deleting any file', async (t) => {
  const root = await tempWorkspace(t)
  const sourceDir = await tempWorkspace(t)
  const source = await makeFile(join(sourceDir, 'tia.ap17'), 'bytes')
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei', source_path: source }, fakeExec(root))
  await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))
  const workFile = join(root, 'projects', 'pei', 'work', 'tia.ap17')

  const plan = await executeTool(project(tools), { action: 'forget' }, fakeExec(root))
  assert.equal(plan.dryRun, true)
  let document = JSON.parse(await readFile(join(root, '_dsh-eng', 'projects.json'), 'utf8'))
  assert.equal(document.projects.length, 1)

  const done = await executeTool(project(tools), { action: 'forget', dry_run: false }, fakeExec(root))
  assert.equal(done.ok, true)
  document = JSON.parse(await readFile(join(root, '_dsh-eng', 'projects.json'), 'utf8'))
  assert.equal(document.projects.length, 0)
  assert.equal(document.current, null)
  assert.equal(await readFile(workFile, 'utf8'), 'bytes', 'forget must never delete the working copy')
  assert.deepEqual(await readdir(join(root, '_dsh-eng')), ['projects.json'])
})

test('eng_scope selects and clears, and refuses an unknown project', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'a' }, fakeExec(root))
  await executeTool(project(tools), { action: 'register', project_id: 'b' }, fakeExec(root))

  const selected = await executeTool(scope(tools), { action: 'select', project_id: 'b' }, fakeExec(root))
  assert.equal(selected.ok, true)
  assert.equal(selected.data.current, 'b')
  assert.equal(selected.data.changed, true)

  const again = await executeTool(scope(tools), { action: 'select', project_id: 'b' }, fakeExec(root))
  assert.equal(again.data.changed, false)

  const unknown = await executeTool(scope(tools), { action: 'select', project_id: 'zzz' }, fakeExec(root))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'project_not_found')
  assert.deepEqual(unknown.error.details.available, ['a', 'b'])

  const cleared = await executeTool(scope(tools), { action: 'clear' }, fakeExec(root))
  assert.equal(cleared.ok, true)
  assert.equal(cleared.data.current, null)
  assert.equal(cleared.data.previous, 'b')

  const missingId = await executeTool(scope(tools), { action: 'select' }, fakeExec(root))
  assert.equal(missingId.error.code, 'invalid_argument')
})

test('an ambiguous scope is reported rather than guessed', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'a' }, fakeExec(root))
  await executeTool(project(tools), { action: 'register', project_id: 'b' }, fakeExec(root))
  await executeTool(scope(tools), { action: 'clear' }, fakeExec(root))

  const view = await executeTool(status(tools), {}, fakeExec(root))
  assert.equal(view.ok, true)
  assert.equal(view.scope.project, null)
  assert.equal(view.scope.projectCount, 2)
  assert.ok(view.warnings.some((warning) => /none is selected/u.test(warning)))

  const adopt = await executeTool(project(tools), { action: 'adopt' }, fakeExec(root))
  assert.equal(adopt.ok, false)
  assert.equal(adopt.error.code, 'project_ambiguous')
  assert.deepEqual(adopt.error.details.available, ['a', 'b'])
})

test('two workspaces never see each other projects', async (t) => {
  const first = await tempWorkspace(t)
  const second = await tempWorkspace(t)
  const { tools } = await setup()

  await executeTool(project(tools), { action: 'register', project_id: 'pei', title: 'PEI' }, fakeExec(first))
  await executeTool(project(tools), { action: 'register', project_id: 'other', title: 'Other' }, fakeExec(second))

  const inFirst = await executeTool(project(tools), { action: 'list' }, fakeExec(first))
  const inSecond = await executeTool(project(tools), { action: 'list' }, fakeExec(second))
  assert.deepEqual(inFirst.data.projects.map((row) => row.id), ['pei'])
  assert.deepEqual(inSecond.data.projects.map((row) => row.id), ['other'])

  // Same id in two workspaces must not collide either.
  const same = await executeTool(project(tools), { action: 'register', project_id: 'pei' }, fakeExec(second))
  assert.equal(same.ok, true)
})

test('list reports whether each recorded path exists', async (t) => {
  const root = await tempWorkspace(t)
  const sourceDir = await tempWorkspace(t)
  const source = await makeFile(join(sourceDir, 'tia.ap17'), 'bytes')
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei', source_path: source }, fakeExec(root))
  await executeTool(project(tools), { action: 'adopt', dry_run: false }, fakeExec(root))

  const listed = await executeTool(project(tools), { action: 'list' }, fakeExec(root))
  const row = listed.data.projects[0]
  assert.equal(row.id, 'pei')
  assert.equal(row.current, true)
  assert.equal(row.workState, 'file')
  assert.equal(row.exportState, 'missing')
  assert.equal(row.adopted, true)
})

test('a corrupted registry is reported, never rebuilt', async (t) => {
  const root = await tempWorkspace(t)
  const { tools } = await setup()
  const file = await makeFile(join(root, '_dsh-eng', 'projects.json'), '{ broken')

  const outcome = await executeTool(status(tools), {}, fakeExec(root))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'registry_invalid')

  // The damaged file is left exactly as it was.
  assert.equal(await readFile(file, 'utf8'), '{ broken')
})

test('a registry created for another workspace still resolves its relative paths, with a warning', async (t) => {
  const root = await tempWorkspace(t)
  const other = await tempWorkspace(t)
  const { tools } = await setup()
  await executeTool(project(tools), { action: 'register', project_id: 'pei' }, fakeExec(root))

  const document = JSON.parse(await readFile(join(root, '_dsh-eng', 'projects.json'), 'utf8'))
  document.workspacePath = other
  await makeFile(join(root, '_dsh-eng', 'projects.json'), JSON.stringify(document))

  const outcome = await executeTool(status(tools), {}, fakeExec(root))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.scope.project.id, 'pei')
  assert.ok(outcome.warnings.some((warning) => /was created in/u.test(warning)))
})
