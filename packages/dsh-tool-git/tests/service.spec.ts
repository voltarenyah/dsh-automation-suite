import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as gitPlugin from '../src/index.ts'
import {
  callTool,
  makeTempDir,
  makeTempRepo,
  makeUnbornRepo,
  setupHostOnly,
  setupPlugin,
  setupToolsOnly,
} from './helpers.ts'

type Result = Awaited<ReturnType<typeof callTool>>
const value = (result: Result): Record<string, unknown> => result.value as Record<string, unknown>
const errorMessage = (result: Result): string =>
  String((result as { error?: { message?: string } }).error?.message ?? '')

/** Run git in an arbitrary directory; throws on non-zero exit. */
const gitAt = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

/** Minimal view of the tool registry's public `view()` method for schema checks. */
interface VisibleTool {
  parameters: { properties: Record<string, unknown> }
}
interface InspectableTools {
  view(scope?: unknown): { visible: Map<string, VisibleTool> }
}

const TOOL_NAMES = [
  'git_status', 'git_diff', 'git_log', 'git_branch', 'git_stage', 'git_commit',
  'git_stash', 'git_show', 'git_fetch', 'git_pull', 'git_remote', 'git_checkout',
]

describe('gitContext service + host/tools split', () => {
  const cleanup: Array<() => void> = []

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn()
  })

  async function boot(cwd: string): Promise<Context> {
    const ctx = await setupPlugin({ cwd })
    return ctx
  }

  /** Fetch the registered service, failing the test if it is missing. */
  function serviceOf(ctx: Context) {
    const service = ctx.get('gitContext')
    if (!service) throw new Error('gitContext service was not registered by the host row')
    return service
  }

  describe('service registration', () => {
    it('host entry provides gitContext and its defaults', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const ctx = await boot(repo.dir)
      const service = serviceOf(ctx)
      expect(service.defaults).toEqual({ logMaxCommits: 20, diffContextLines: 3 })
    })

    it('copies logMaxCommits / diffContextLines from the host config', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const ctx = await setupPlugin({ cwd: repo.dir, logMaxCommits: 7, diffContextLines: 5 })
      expect(serviceOf(ctx).defaults).toEqual({ logMaxCommits: 7, diffContextLines: 5 })
    })

    it('host Config no longer exposes workDir and keeps the other defaults', () => {
      const parseConfig = gitPlugin.Config as unknown as (value: unknown) => Record<string, unknown>
      const defaults = parseConfig({})
      expect(defaults).not.toHaveProperty('workDir')
      expect(defaults).toEqual({
        gitPath: 'git',
        destructivePolicy: 'deny',
        extraDestructivePatterns: [],
        logMaxCommits: 20,
        diffContextLines: 3,
      })
    })
  })

  describe('root resolution', () => {
    it('create() binds to the explicit root, not process.cwd() and not another repo', async () => {
      const repoA = makeTempRepo()
      const repoB = makeTempRepo()
      cleanup.push(repoA.cleanup, repoB.cleanup)
      const service = serviceOf(await boot(repoA.dir))

      const a = await service.create(repoA.dir)
      const b = await service.create(repoB.dir)
      expect(a.repoDir).toBe(resolve(repoA.dir))
      expect(b.repoDir).toBe(resolve(repoB.dir))
      expect(a.repoDir).not.toBe(b.repoDir)
      // The monorepo checkout is itself a repository; a process-cwd fallback
      // would have reported it instead of the explicit roots above.
      expect(a.repoDir).not.toBe(resolve(process.cwd()))

      repoA.write('a.txt', 'a\n')
      repoB.write('b.txt', 'b\n')
      expect(await a.status([])).toEqual(['?? a.txt'])
      expect(await a.status(['a.txt'])).toEqual(['?? a.txt'])
      expect(await b.status([])).toEqual(['?? b.txt'])
    })

    it('repoRoot returns null and isRepository false outside a repository', async () => {
      const repo = makeTempRepo()
      const plain = makeTempDir()
      cleanup.push(repo.cleanup, plain.cleanup)
      const service = serviceOf(await boot(repo.dir))

      expect(await service.repoRoot(plain.dir)).toBeNull()
      expect(await service.isRepository(plain.dir)).toBe(false)
      expect(await service.repoRoot(repo.dir)).toBe(resolve(repo.dir))
      expect(await service.isRepository(repo.dir)).toBe(true)
      await expect(service.create(plain.dir)).rejects.toThrow(/not inside a git repository/)
    })

    it('rejects a relative root instead of resolving it against process.cwd()', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const service = serviceOf(await boot(repo.dir))
      await expect(service.create('.')).rejects.toThrow(/must be absolute/)
      await expect(service.repoRoot('.')).rejects.toThrow(/must be absolute/)
    })
  })

  describe('bound context', () => {
    it('run() returns a non-zero exit as data and runChecked() throws', async () => {
      const repo = makeUnbornRepo()
      cleanup.push(repo.cleanup)
      const service = serviceOf(await boot(repo.dir))
      const git = await service.create(repo.dir)

      const raw = await git.run(['rev-parse', '--verify', 'HEAD'])
      expect(raw.code).not.toBe(0)
      expect(typeof raw.stdout).toBe('string')
      expect(typeof raw.stderr).toBe('string')
      await expect(git.runChecked(['rev-parse', '--verify', 'HEAD'])).rejects.toThrow()
    })

    it('head() is null on an unborn branch', async () => {
      const repo = makeUnbornRepo()
      cleanup.push(repo.cleanup)
      const git = await serviceOf(await boot(repo.dir)).create(repo.dir)
      expect(await git.head()).toBeNull()
    })

    it('commit() stages a path and commits it', async () => {
      const repo = makeUnbornRepo()
      cleanup.push(repo.cleanup)
      const git = await serviceOf(await boot(repo.dir)).create(repo.dir)
      repo.write('first.txt', 'hello\n')

      const result = await git.commit(['first.txt'], 'first commit')
      expect(result.committed).toBe(true)
      expect(result.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(await git.head()).toBe(result.hash)
      expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('first commit')
      expect(repo.git(['status', '--porcelain'])).toBe('')
    })

    it('commit() reports a clean tree as data instead of throwing', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const git = await serviceOf(await boot(repo.dir)).create(repo.dir)
      expect(await git.commit([], 'nothing to do')).toEqual({ committed: false, hash: null })
    })

    it('status() includes untracked files and honors a paths filter', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      repo.write('one.txt', 'one\n')
      repo.write('two.txt', 'two\n')
      const git = await serviceOf(await boot(repo.dir)).create(repo.dir)
      expect(await git.status(['one.txt'])).toEqual(['?? one.txt'])
      expect((await git.status([])).sort()).toEqual(['?? one.txt', '?? two.txt'])
    })
  })

  describe('init', () => {
    it('initializes a fresh repository at the explicit root and returns its context', async () => {
      const holder = makeTempDir()
      const decoy = makeTempRepo()
      cleanup.push(holder.cleanup, decoy.cleanup)
      const service = serviceOf(await boot(decoy.dir))

      const git = await service.init(holder.dir)
      expect(git.repoDir).toBe(resolve(holder.dir))
      expect(await service.isRepository(holder.dir)).toBe(true)
      expect(gitAt(holder.dir, ['branch', '--show-current']).trim()).toBe('main')
      // The decoy repository was only the session cwd, never the init target.
      expect(decoy.git(['status', '--porcelain'])).toBe('')
      expect(await service.repoRoot(decoy.dir)).toBe(resolve(decoy.dir))
    })

    it('honors initialBranch and can commit immediately', async () => {
      const holder = makeTempDir()
      const decoy = makeTempRepo()
      cleanup.push(holder.cleanup, decoy.cleanup)
      const service = serviceOf(await boot(decoy.dir))

      const git = await service.init(holder.dir, { initialBranch: 'trunk' })
      expect(gitAt(holder.dir, ['branch', '--show-current']).trim()).toBe('trunk')
      expect(await git.head()).toBeNull()
      gitAt(holder.dir, ['config', 'user.name', 'Test User'])
      gitAt(holder.dir, ['config', 'user.email', 'test@example.com'])
      gitAt(holder.dir, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(resolve(holder.dir, 'README.md'), '# fresh\n')
      const result = await git.commit(['README.md'], 'initial commit')
      expect(result.committed).toBe(true)
      expect(await git.head()).toBe(result.hash)
    })

    it('refuses a missing root', async () => {
      const repo = makeTempRepo()
      const plain = makeTempDir()
      cleanup.push(repo.cleanup, plain.cleanup)
      const service = serviceOf(await boot(repo.dir))
      await expect(service.init(resolve(plain.dir, 'does-not-exist'))).rejects.toThrow(
        /not an existing directory/,
      )
    })
  })

  describe('model tools split', () => {
    it('the host entry registers no model tools', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const ctx = await setupHostOnly({ cwd: repo.dir })
      expect(ctx.get('gitContext')).toBeDefined()
      const result = await callTool(ctx, 'git_status', {})
      expect(result.isError).toBe(true)
      expect(errorMessage(result)).toMatch(/unknown tool "git_status"/)
    })

    it('the /tools entry registers all twelve tools without a repoDir parameter', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const ctx = await boot(repo.dir)
      const { visible } = (ctx.tools as unknown as InspectableTools).view()
      const gitTools = [...visible.keys()].filter(name => name.startsWith('git_')).sort()
      expect(gitTools).toEqual([...TOOL_NAMES].sort())
      for (const name of gitTools) {
        expect(visible.get(name)!.parameters.properties, `${name} must not accept repoDir`)
          .not.toHaveProperty('repoDir')
      }
    })

    it('fails closed when the host row is missing: /tools registers nothing', async () => {
      const repo = makeTempRepo()
      cleanup.push(repo.cleanup)
      const ctx = await setupToolsOnly(repo.dir)
      expect(ctx.get('gitContext')).toBeUndefined()
      const { visible } = (ctx.tools as unknown as InspectableTools).view()
      expect([...visible.keys()].filter(name => name.startsWith('git_'))).toEqual([])
      const result = await callTool(ctx, 'git_status', {})
      expect(result.isError).toBe(true)
      expect(errorMessage(result)).toMatch(/unknown tool "git_status"/)
    })

    it('a tool without a path acts on the session cwd and leaves a decoy repo untouched', async () => {
      const sessionRepo = makeTempRepo()
      const decoy = makeTempRepo()
      cleanup.push(sessionRepo.cleanup, decoy.cleanup)
      decoy.write('decoy.txt', 'decoy\n')

      const ctx = await boot(sessionRepo.dir)
      const status = await callTool(ctx, 'git_status', {})
      expect(status.isError).toBe(false)
      expect(value(status).repoDir).toBe(resolve(sessionRepo.dir))
      expect(value(status).untracked).toEqual([])

      // A write path as well: stage + commit must land in the session repo.
      sessionRepo.write('README.md', '# hello\nsession\n')
      const staged = await callTool(ctx, 'git_stage', { paths: ['README.md'] })
      expect(staged.isError).toBe(false)
      const committed = await callTool(ctx, 'git_commit', { message: 'session change' })
      expect(committed.isError).toBe(false)
      expect(value(committed)).toMatchObject({ committed: true, subject: 'session change' })

      expect(sessionRepo.git(['log', '-1', '--format=%s']).trim()).toBe('session change')
      expect(decoy.git(['log', '-1', '--format=%s']).trim()).toBe('initial commit')
      expect(decoy.git(['log', '--oneline']).trim().split('\n')).toHaveLength(1)
      expect(decoy.git(['status', '--porcelain'])).toContain('?? decoy.txt')
    })
  })
})
