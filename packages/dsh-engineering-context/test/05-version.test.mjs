/**
 * The version layer, driven against **real** git repositories in temp directories.
 *
 * What is asserted is what the design promises: only the export tree and the
 * plugin state are versioned (never the binary `.ap17`), committing is a dry run
 * unless asked twice, a workspace without a repository is reported rather than
 * initialized behind the user's back, and the diff of a large tree goes to an
 * artifact instead of into the context.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  renderedText,
  tempWorkspace,
} from './helpers/harness.mjs'

const run = promisify(execFile)
const { resolveConfig } = await loadConfigModule()
const { toolDefinitions } = await loadToolsModule()

const config = resolveConfig()

/** Whether a real git is available; the whole file is skipped when it is not. */
async function gitAvailable() {
  try {
    await run('git', ['--version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

const GIT = await gitAvailable()

async function git(args, cwd) {
  const result = await run('git', args, { cwd, windowsHide: true })
  return String(result.stdout ?? '')
}

/** A temp workspace turned into a repository, with local identity configured. */
async function repositoryWorkspace(t) {
  const root = await tempWorkspace(t)
  await git(['init'], root)
  await git(['config', 'user.email', 'test@example.invalid'], root)
  await git(['config', 'user.name', 'engineering-context test'], root)
  await git(['config', 'commit.gpgsign', 'false'], root)
  return root
}

/** Register a project, create its export tree, and return the workspace root. */
async function projectWorkspace(t, root) {
  const source = await makeFile(join(root, '..', `src-${Date.now()}-${Math.random()}.ap17`), 'project-bytes')
  const { ctx } = createTestContext()
  const tools = toolDefinitions({ ctx, config, log: ctx.logger })
  const registered = await executeTool(
    findTool(tools, 'eng_project'),
    { action: 'register', project_id: 'pei', title: 'PEI', source_path: source },
    fakeExec(root),
  )
  assert.equal(registered.ok, true)

  await makeFile(join(root, 'projects', 'pei', 'export', 'FB_Motor.xml'), '<Document>v1</Document>')
  await makeFile(join(root, 'projects', 'pei', 'export', 'decoy.ap17'), 'binary-project-bytes')
  await makeFile(join(root, '_dsh-eng', 'pei', 'fingerprints.json'), '{"schemaVersion":1}')
  // The user's own ignore rule is what keeps the binary project out of history.
  await makeFile(join(root, '.gitignore'), '**/*.ap17\n')
  return tools
}

async function version(tools, args, root) {
  return await executeTool(findTool(tools, 'eng_version'), args, fakeExec(root))
}

test('a workspace without a repository is reported, never initialized', { skip: !GIT }, async (t) => {
  const root = await tempWorkspace(t)
  const tools = await projectWorkspace(t, root)

  const current = await version(tools, { action: 'current' }, root)
  assert.equal(current.ok, true)
  assert.equal(current.data.repository.isRepository, false)
  assert.match(renderedText(findTool(tools, 'eng_version'), { action: 'current' }, current), /eng_version:/u)
  assert.ok(current.warnings.some((warning) => /not inside a git repository/u.test(warning)))
  assert.ok(current.warnings.some((warning) => /never initializes a repository/u.test(warning)))

  // And the plugin did not create one.
  await assert.rejects(stat(join(root, '.git')))

  const commit = await version(tools, { action: 'commit', message: 'x', dry_run: false }, root)
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'repository_not_found')

  const diff = await version(tools, { action: 'diff' }, root)
  assert.equal(diff.ok, false)
  assert.equal(diff.error.code, 'repository_not_found')
})

test('current reports the revision and what is uncommitted in the versioned paths', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)

  const outcome = await version(tools, { action: 'current' }, root)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.repository.isRepository, true)
  assert.equal(outcome.data.head, null, 'a freshly initialized repository has no commit yet')
  assert.deepEqual(outcome.data.versionedPaths, ['projects/pei/export', '_dsh-eng/pei'])
  // File-level, not directory-level: the decoy .ap17 is ignored, so the export
  // tree contributes exactly one entry plus the state file.
  assert.equal(outcome.data.uncommittedCount, 2)
  assert.ok(outcome.data.uncommitted.some((line) => line.includes('FB_Motor.xml')))
  assert.ok(outcome.data.uncommitted.some((line) => line.includes('_dsh-eng/pei/fingerprints.json')))
  assert.equal(
    outcome.data.uncommitted.some((line) => line.includes('decoy.ap17')),
    false,
    'the ignored .ap17 must not be reported as a change',
  )
})

test('commit stays a dry run until asked twice, and never commits the .ap17', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)

  const plan = await version(tools, { action: 'commit', message: 'baseline export' }, root)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.data.hash ?? null, null)
  // Nothing was committed: HEAD is still unborn.
  await assert.rejects(git(['rev-parse', '--verify', 'HEAD'], root))

  const missingMessage = await version(tools, { action: 'commit', dry_run: false }, root)
  assert.equal(missingMessage.ok, false)
  assert.equal(missingMessage.error.code, 'invalid_argument')

  const committed = await version(tools, { action: 'commit', message: 'baseline export', dry_run: false }, root)
  assert.equal(committed.ok, true)
  assert.equal(committed.dryRun, false)
  assert.match(committed.data.hash, /^[0-9a-f]{40}$/u)

  const tracked = await git(['ls-files'], root)
  assert.ok(tracked.includes('projects/pei/export/FB_Motor.xml'), 'the export tree must be versioned')
  assert.ok(tracked.includes('_dsh-eng/pei/fingerprints.json'), 'the project state must be versioned')
  assert.equal(tracked.includes('.ap17'), false, 'no .ap17 may ever be committed')
  assert.equal(/\.ap17/u.test(tracked), false, 'the decoy .ap17 must be excluded by .gitignore')

  // A second commit with nothing changed reports that, rather than inventing one.
  const again = await version(tools, { action: 'commit', message: 'nothing', dry_run: false }, root)
  assert.equal(again.ok, true)
  assert.equal(again.data.hash, null)
  assert.match(again.summary, /Nothing to commit/u)
})

test('log lists the commits that touched the versioned paths', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)
  await version(tools, { action: 'commit', message: 'baseline export', dry_run: false }, root)

  const logged = await version(tools, { action: 'log' }, root)
  assert.equal(logged.ok, true)
  assert.equal(logged.data.commits.length, 1)
  assert.equal(logged.data.commits[0].subject, 'baseline export')
  assert.match(logged.data.commits[0].hash, /^[0-9a-f]{40}$/u)
})

test('diff summarises the change and writes the full patch as an artifact', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)
  await version(tools, { action: 'commit', message: 'baseline export', dry_run: false }, root)

  // Change one exported object and commit it, so there is a range to compare.
  await makeFile(join(root, 'projects', 'pei', 'export', 'FB_Motor.xml'), '<Document>v2</Document>')
  await makeFile(join(root, 'projects', 'pei', 'export', 'FC_New.xml'), '<Document>new</Document>')
  const second = await version(tools, { action: 'commit', message: 'tweak the motor block', dry_run: false }, root)
  assert.equal(second.ok, true)

  const summary = await version(tools, { action: 'diff', from: 'HEAD^', to: 'HEAD' }, root)
  assert.equal(summary.ok, true)
  assert.equal(summary.data.files.length, 2)
  assert.deepEqual(summary.data.byStatus, { M: 1, A: 1 })
  assert.equal(summary.data.artifact, null)
  const paths = summary.data.files.map((file) => file.path).sort()
  assert.deepEqual(paths, ['projects/pei/export/FB_Motor.xml', 'projects/pei/export/FC_New.xml'].sort())

  const full = await version(tools, { action: 'diff', from: 'HEAD^', to: 'HEAD', full: true }, root)
  assert.equal(full.ok, true)
  assert.match(full.data.artifact, /^_dsh-eng\/pei\/diffs\//u)
  const patch = await readFile(join(root, full.data.artifact), 'utf8')
  assert.match(patch, /FB_Motor\.xml/u)
  assert.match(patch, /\+<Document>v2<\/Document>/u)
})

test('diff on an unchanged range says so without claiming the engineering did not change', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)
  await version(tools, { action: 'commit', message: 'baseline export', dry_run: false }, root)

  const outcome = await version(tools, { action: 'diff', from: 'HEAD', to: 'HEAD' }, root)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.files.length, 0)
  assert.ok(
    outcome.warnings.some((warning) => /not the same as "the engineering did not change"/u.test(warning)),
    'an empty diff must not be presented as "nothing changed in the project"',
  )
})

test('an unusable revision is reported as data, not as a crash', { skip: !GIT }, async (t) => {
  const root = await repositoryWorkspace(t)
  const tools = await projectWorkspace(t, root)
  await version(tools, { action: 'commit', message: 'baseline export', dry_run: false }, root)

  const bad = await version(tools, { action: 'diff', from: 'no-such-revision', to: 'HEAD' }, root)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'git_failed')
  assert.ok(bad.error.details.stderr.length > 0, 'git stderr is kept so the caller can act on it')
})
