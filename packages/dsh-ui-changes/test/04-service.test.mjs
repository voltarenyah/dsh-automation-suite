/**
 * The git-backed service, driven through a fake `gitContext`.
 *
 * The fake returns the same shapes the real service does (non-zero exits are
 * data, aborts reject with `AbortError`), so these tests pin the decisions that
 * are easy to get wrong: which commands run, how a rename/binary/untracked file
 * is counted, what a missing session or repository answers, and when the cache
 * is allowed to skip git entirely.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { StatusError } from '../lib/errors.js'
import { createStatusService } from '../lib/service.js'

const HEAD_OK = { code: 0, stdout: 'abc1234567890\n', stderr: '' }
const SYMBOLIC_MAIN = { code: 0, stdout: 'main\n', stderr: '' }
const STATUS_DIRTY = { code: 0, stdout: ' M a.txt\0?? fresh.txt\0', stderr: '' }
const DIFF_ONE = { code: 0, stdout: '3\t1\ta.txt\0', stderr: '' }

/**
 * @param {(args: string[], options: { signal?: AbortSignal }) => object} handler - per-command answer.
 * @param {string} [repoDir] - the repository the fake binds to.
 * @returns {{ service: object, calls: string[] }} the fake service and its call log.
 */
function makeGit(handler, repoDir = 'C:/repo') {
  const calls = []
  const service = {
    async create() {
      return {
        repoDir,
        run: async (args, options) => {
          calls.push(args.join(' '))
          return handler(args, options ?? {})
        },
      }
    },
  }
  return { service, calls }
}

/**
 * @param {Record<string, object>} table - exact command → result.
 * @returns {(args: string[]) => object} a handler that refuses unknown commands.
 */
function answers(table) {
  return (args) => {
    const key = args.join(' ')
    const hit = table[key]
    if (hit === undefined) throw new Error(`unexpected git call: ${key}`)
    return hit
  }
}

/** @returns {object} the deps every happy-path test starts from. */
function deps(over = {}) {
  return {
    git: () => makeGit(answers({
      'rev-parse --verify HEAD': HEAD_OK,
      'symbolic-ref --short HEAD': SYMBOLIC_MAIN,
      'status --porcelain=v1 -z --untracked-files=all': STATUS_DIRTY,
      'diff --numstat -z -M HEAD': DIFF_ONE,
    })).service,
    sessionCwd: () => 'C:/ws',
    readTextFile: async (path) => (path.endsWith('fresh.txt') ? 'x\ny\n' : null),
    limits: { cacheMs: 0 },
    ...over,
  }
}

describe('status', () => {
  it('builds the payload from git output', async () => {
    const service = createStatusService(deps())
    const payload = await service.status('session-1')
    assert.equal(payload.repo, 'C:/repo')
    assert.equal(payload.branch, 'main')
    assert.equal(payload.detached, false)
    assert.equal(payload.head, 'abc1234567890')
    assert.equal(payload.files.length, 2)
    const byPath = Object.fromEntries(payload.files.map((file) => [file.path, file]))
    assert.equal(byPath['a.txt'].adds, 3)
    assert.equal(byPath['a.txt'].dels, 1)
    assert.equal(byPath['fresh.txt'].adds, 2)
    assert.deepEqual(payload.totals, { files: 2, adds: 5, dels: 1, truncated: false })
  })

  it('uses --cached on an unborn branch', async () => {
    const { service: git, calls } = makeGit(answers({
      'rev-parse --verify HEAD': { code: 128, stdout: '', stderr: 'fatal: bad revision' },
      'symbolic-ref --short HEAD': SYMBOLIC_MAIN,
      'status --porcelain=v1 -z --untracked-files=all': { code: 0, stdout: 'A  first.txt\0', stderr: '' },
      'diff --numstat -z -M --cached': { code: 0, stdout: '4\t0\tfirst.txt\0', stderr: '' },
    }))
    const payload = await createStatusService(deps({ git: () => git, readTextFile: undefined })).status('s')
    assert.equal(payload.head, null)
    assert.equal(payload.files[0].adds, 4)
    assert.equal(calls.includes('diff --numstat -z -M --cached'), true)
  })

  it('reports a detached head', async () => {
    const { service: git } = makeGit(answers({
      'rev-parse --verify HEAD': HEAD_OK,
      'symbolic-ref --short HEAD': { code: 1, stdout: '', stderr: '' },
      'status --porcelain=v1 -z --untracked-files=all': { code: 0, stdout: '', stderr: '' },
      'diff --numstat -z -M HEAD': { code: 0, stdout: '', stderr: '' },
    }))
    const payload = await createStatusService(deps({ git: () => git })).status('s')
    assert.equal(payload.detached, true)
    assert.equal(payload.branch, 'HEAD')
    assert.equal(payload.files.length, 0)
  })

  it('truncates the list but keeps the full count', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ` M f${i}.txt`).join('\0') + '\0'
    const { service: git } = makeGit(answers({
      'rev-parse --verify HEAD': HEAD_OK,
      'symbolic-ref --short HEAD': SYMBOLIC_MAIN,
      'status --porcelain=v1 -z --untracked-files=all': { code: 0, stdout: many, stderr: '' },
      'diff --numstat -z -M HEAD': { code: 0, stdout: '', stderr: '' },
    }))
    const payload = await createStatusService(deps({ git: () => git, limits: { maxFiles: 3, cacheMs: 0 } })).status('s')
    assert.equal(payload.files.length, 3)
    assert.equal(payload.totals.files, 5)
    assert.equal(payload.totals.truncated, true)
  })

  it('fails with changes/session-unknown for an unknown session', async () => {
    const service = createStatusService(deps({ sessionCwd: () => null }))
    await assert.rejects(service.status('nope'), isError('changes/session-unknown'))
  })

  it('fails the same way when the session store throws', async () => {
    const service = createStatusService(deps({
      sessionCwd: () => {
        throw new Error('store exploded')
      },
    }))
    await assert.rejects(service.status('nope'), isError('changes/session-unknown'))
  })

  it('fails with changes/no-git-service when the plugin is absent', async () => {
    const service = createStatusService(deps({ git: () => undefined }))
    await assert.rejects(service.status('s'), isError('changes/no-git-service'))
  })

  it('maps "not inside a git repository" onto its own code', async () => {
    const service = createStatusService(deps({
      git: () => ({
        async create() {
          throw new Error('not inside a git repository: C:/ws')
        },
      }),
    }))
    await assert.rejects(service.status('s'), isError('changes/not-a-repository'))
  })

  it('maps a failing git read onto changes/git-failed', async () => {
    const { service: git } = makeGit(answers({
      'rev-parse --verify HEAD': HEAD_OK,
      'symbolic-ref --short HEAD': SYMBOLIC_MAIN,
      'status --porcelain=v1 -z --untracked-files=all': { code: 128, stdout: '', stderr: 'fatal: index.lock' },
    }))
    await assert.rejects(
      createStatusService(deps({ git: () => git })).status('s'),
      isError('changes/git-failed'),
    )
  })

  it('times out a git command that never answers', async () => {
    const { service: git } = makeGit(
      (args, options) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }, { once: true })
        }),
    )
    await assert.rejects(
      createStatusService(deps({ git: () => git, limits: { timeoutMs: 30, cacheMs: 0 } })).status('s'),
      isError('changes/timeout'),
    )
  })

  it('reuses the payload inside the cache window', async () => {
    const { service: git, calls } = makeGit(answers({
      'rev-parse --verify HEAD': HEAD_OK,
      'symbolic-ref --short HEAD': SYMBOLIC_MAIN,
      'status --porcelain=v1 -z --untracked-files=all': STATUS_DIRTY,
      'diff --numstat -z -M HEAD': DIFF_ONE,
    }))
    const service = createStatusService(deps({
      git: () => git,
      limits: { cacheMs: 10_000 },
      now: () => 1_000,
    }))
    const first = await service.status('s')
    const second = await service.status('s')
    assert.equal(first, second)
    assert.equal(calls.filter((call) => call.startsWith('status ')).length, 1)
  })
})

/**
 * @param {string} code - expected {@link StatusError} code.
 * @returns {(error: unknown) => boolean} a `assert.rejects` predicate.
 */
function isError(code) {
  return (error) => {
    assert.equal(error instanceof StatusError, true, `expected StatusError, got ${error?.name}`)
    assert.equal(error.code, code)
    return true
  }
}
