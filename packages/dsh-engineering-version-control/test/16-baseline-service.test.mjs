/**
 * The `versionControl` service: the baseline commit, against a **real** repository.
 *
 * This is where the baseline behaviour moved from `create_engineering_project`
 * (S2b of the split). The tests that used to drive it through the create tool's
 * fake `gitContext` live here now, driving the service directly — the tool only
 * forwards, so the behaviour belongs to the service.
 *
 * The git context is a thin adapter over real `git` in a temp workspace: the
 * commit's trailers, the marker, the store replay and the "this repository is not
 * ours" refusal are only meaningful against a real repository.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { makeFile, tempWorkspace } from './helpers/harness.mjs'

const { createVersionControlService, versionControl } = await import('../lib/service.js')
const { resolveConfig } = await import('../lib/config.js')
const execFileAsync = promisify(execFile)

const ENTRY = 'PEI_SinoARP'

async function git(root, args) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** A `gitContext`-shaped adapter over the real `git` binary. */
function realGitService({ commitThrows = null } = {}) {
  const calls = []
  const bound = (repoDir) => ({
    repoDir,
    async commit(paths, message) {
      calls.push({ operation: 'commit', paths, message })
      if (commitThrows !== null) throw commitThrows
      await git(repoDir, ['add', '--', ...paths])
      const committed = await git(repoDir, ['commit', '-q', '-m', message])
      if (committed.code !== 0) throw new Error(committed.stderr || 'git commit failed')
      const head = await git(repoDir, ['rev-parse', 'HEAD'])
      return { committed: true, hash: head.stdout.trim() }
    },
    async run(args) {
      return await git(repoDir, args)
    },
    async status(paths) {
      const result = await git(repoDir, ['status', '--porcelain', '--', ...paths])
      return result.stdout.split(/\r?\n/u).filter((line) => line.length > 0)
    },
    async head() {
      const result = await git(repoDir, ['rev-parse', 'HEAD'])
      return result.code === 0 ? result.stdout.trim() : null
    },
  })

  return {
    calls,
    service: {
      async isRepository(root) {
        const result = await git(root, ['rev-parse', '--is-inside-work-tree'])
        return result.code === 0 && result.stdout.trim() === 'true'
      },
      async repoRoot(root) {
        const result = await git(root, ['rev-parse', '--show-toplevel'])
        return result.code === 0 ? result.stdout.trim() : null
      },
      async init(root) {
        calls.push({ operation: 'init', root })
        await git(root, ['init', '-q', '-b', 'main'])
        await git(root, ['config', 'user.email', 'test@example.invalid'])
        await git(root, ['config', 'user.name', 'Version Control Test'])
        return bound(root)
      },
      async create(root) {
        calls.push({ operation: 'create', root })
        return bound(root)
      },
    },
  }
}

/** A workspace that already holds an exported source tree. */
async function exportedWorkspace(t) {
  const root = await tempWorkspace(t)
  await makeFile(join(root, '.gitignore'), '.dsh/\n')
  await makeFile(join(root, '.gitattributes'), '* text=auto\n')
  await makeFile(join(root, 'source', 'PLC1', 'blocks', 'FB1.xml'), '<xml>one</xml>')
  await makeFile(
    join(root, 'source', 'PLC1', '_evidence.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      hashAlgo: 'sha256',
      device: 'PLC1',
      software: 'SW1',
      plcChecksum: 'AA',
      stateId: 'state-1',
      objects: {
        'block||FB1': {
          category: 'block',
          name: 'FB1',
          group: '010',
          path: 'blocks/FB1.xml',
          fingerprint: { Code: 'fingerprint-1' },
        },
      },
      unexportable: [],
      tombstones: [],
    })}\n`,
  )
  return root
}

function deps(root, gitService, config = resolveConfig()) {
  const services = new Map([['gitContext', gitService.service]])
  const ctx = {
    get: (name) => services.get(name),
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, service: createVersionControlService(ctx, config), config }
}

/** Absolute paths, like `engineering-context` passes: a relative one would make
 *  `gitPath()` point outside the repository and silently skip the replay. */
function baselineOf(root) {
  return {
    sourceRoot: join(root, 'source'),
    device: { device: 'PLC1', software: 'SW1', directory: join(root, 'source', 'PLC1') },
    label: ENTRY,
    checksum: 'AA',
    stateId: 'state-1',
  }
}

test('a fresh workspace is initialized, and the baseline carries the four trailers', async (t) => {
  const root = await exportedWorkspace(t)
  const gitService = realGitService()
  const { service } = deps(root, gitService)

  const plan = await service.planBaseline({ workspace: root })
  assert.equal(plan.state, 'none')
  assert.equal(plan.initialize, true)
  assert.match(plan.description, /not a repository yet/u)

  const result = await service.recordBaseline({ workspace: root, ...baselineOf(root) })

  assert.equal(result.initialized, true)
  assert.equal(result.committed, true)
  assert.match(result.hash ?? '', /^[0-9a-f]{40}$/u)
  assert.deepEqual(gitService.calls.map((call) => call.operation), ['init', 'commit'])

  const message = (await git(root, ['log', '-1', '--format=%B'])).stdout
  assert.match(message, new RegExp(`^create: ${ENTRY} — baseline import of the exported source tree$`, 'mu'))
  assert.match(message, /^Tia-Op: create$/mu)
  assert.match(message, /^Tia-Checksum: AA$/mu)
  assert.match(message, /^Tia-State: state-1$/mu)
  assert.match(message, /^Tia-Manifest: rebuilt$/mu)

  const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split(/\r?\n/u).sort()
  assert.deepEqual(files, ['.gitattributes', '.gitignore', 'source/PLC1/_evidence.json', 'source/PLC1/blocks/FB1.xml'])

  // The marker is written before the commit, so the retry recognizes the repo.
  assert.equal(existsSync(join(root, '.dsh', 'local', 'repo.json')), true)

  // The import's history is queryable right away: the store replay ran.
  assert.equal(existsSync(join(root, '.dsh', 'versions.db')), true)
  assert.equal(result.versionNote !== null, true, `the version store must be recorded: ${result.warnings.join('; ')}`)
  assert.deepEqual(result.warnings, [])

  // The projection the Versions tab reads must show the baseline too: the replay
  // path used to return without refreshing it.
  const view = JSON.parse(await readFile(join(root, '.dsh', 'versions-view.json'), 'utf8'))
  assert.equal(view.counts.versions, 1, 'the baseline is one version in the projection')

  // The store is the authority: one version row (op `create`) and one snapshot set.
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(root, '.dsh', 'versions.db'))
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 1)
    assert.equal(database.prepare('SELECT op FROM versions').get().op, 'create')
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM baseline_snapshots').get().n, 1)
  } finally {
    database.close()
  }
})

test('a repository this workflow created is reused, not re-initialized', async (t) => {
  const root = await exportedWorkspace(t)
  const gitService = realGitService()
  const { service } = deps(root, gitService)

  await service.recordBaseline({ workspace: root, ...baselineOf(root) })
  await makeFile(join(root, 'source', 'PLC1', 'blocks', 'FB1.xml'), '<xml>two</xml>')

  const plan = await service.planBaseline({ workspace: root })
  assert.equal(plan.state, 'reuse')
  assert.equal(plan.initialize, false)
  assert.match(plan.description, /reusing this workflow's repository/u)

  const before = gitService.calls.filter((call) => call.operation === 'init').length
  const second = await service.recordBaseline({ workspace: root, ...baselineOf(root) })
  const after = gitService.calls.filter((call) => call.operation === 'init').length
  assert.equal(after, before, 'the second import must not run git init again')
  assert.equal(second.initialized, false)
  assert.equal(second.committed, true)
})

test('a workspace inside a foreign repository is refused before anything is written', async (t) => {
  const parent = await tempWorkspace(t)
  const root = join(parent, 'inner')
  await mkdir(root, { recursive: true })
  await git(parent, ['init', '-q'])
  await git(parent, ['config', 'user.email', 'test@example.invalid'])
  await git(parent, ['config', 'user.name', 'Test'])
  await makeFile(join(parent, 'readme.md'), 'x\n')
  await git(parent, ['add', '-A'])
  await git(parent, ['commit', '-q', '-m', 'foreign'])

  const gitService = realGitService()
  const { service } = deps(root, gitService)

  await assert.rejects(() => service.planBaseline({ workspace: root }), (error) => {
    assert.equal(error.code, 'workspace_is_repository')
    assert.match(error.message, /inside the git repository/u)
    return true
  })
  assert.deepEqual(gitService.calls, [], 'a refusal must not touch git')
  assert.equal(existsSync(join(root, '.dsh')), false, 'a refusal must not write the marker')
})

test('a repository this workflow cannot attribute is refused', async (t) => {
  const root = await exportedWorkspace(t)
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Test'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'someone else created this'])

  const gitService = realGitService()
  const { service } = deps(root, gitService)

  await assert.rejects(() => service.recordBaseline({ workspace: root, ...baselineOf(root) }), (error) => {
    assert.equal(error.code, 'workspace_is_repository')
    assert.match(error.message, /cannot attribute it/u)
    return true
  })
  assert.equal(gitService.calls.some((call) => call.operation === 'commit'), false)
})

test('a commit failure is surfaced as git_failed, never as a baseline', async (t) => {
  const root = await exportedWorkspace(t)
  const gitService = realGitService({ commitThrows: new Error('fatal: unable to write commit') })
  const { service } = deps(root, gitService)

  await assert.rejects(() => service.recordBaseline({ workspace: root, ...baselineOf(root) }), (error) => {
    assert.equal(error.code, 'git_failed')
    assert.match(error.message, /git baseline could not be created/u)
    assert.match(error.message, /unable to write commit/u)
    assert.equal(error.details.marker !== undefined, true, 'the message must say the marker lets a retry continue')
    return true
  })
  // The marker was written first, on purpose: the retry recognizes the repository.
  assert.equal(existsSync(join(root, '.dsh', 'local', 'repo.json')), true)
})

test('a composition without gitContext refuses with git_access_unavailable', async () => {
  const ctx = { get: () => undefined, logger: () => ({ info() {}, warn() {}, error() {} }) }
  const service = createVersionControlService(ctx, resolveConfig())

  await assert.rejects(() => service.planBaseline({ workspace: 'C:\\ws' }), (error) => {
    assert.equal(error.code, 'git_access_unavailable')
    assert.match(error.message, /dsh-tool-git/u)
    return true
  })
})

test('the caller\'s layout names decide where the marker and the store land', async (t) => {
  const root = await exportedWorkspace(t)
  const gitService = realGitService()
  const { service } = deps(root, gitService, resolveConfig({ stateDirName: '.state', sourceDirName: 'source' }))

  const result = await service.recordBaseline({
    workspace: root,
    ...baselineOf(root),
    stateDirName: '.dsh',
    sourceDirName: 'source',
  })

  assert.equal(result.committed, true)
  assert.equal(existsSync(join(root, '.dsh', 'local', 'repo.json')), true, 'the caller\'s state dir wins')
  assert.equal(existsSync(join(root, '.state')), false)
})

test('versionControl() only accepts a service carrying both calls', () => {
  const make = (value) => ({ get: () => value })
  assert.equal(versionControl(make({ planBaseline() {}, recordBaseline() {} })) !== undefined, true)
  assert.equal(versionControl(make({ planBaseline() {} })), undefined)
  assert.equal(versionControl(make(null)), undefined)
})

