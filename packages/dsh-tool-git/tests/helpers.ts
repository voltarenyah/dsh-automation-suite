/**
 * Test fixtures: disposable git repositories and a booted plugin context.
 * @module dsh-tool-git/tests/helpers
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as gitPlugin from '../src/index.ts'
import * as toolsEntry from '../src/tools-entry.ts'

/** A disposable repository with one initial commit on `main`. */
export interface TempRepo {
  dir: string
  /** Remove the repository and all its files. */
  cleanup: () => void
  /** Run git in the repository; throws on non-zero exit. */
  git: (args: string[]) => string
  /** Write a file relative to the repository root. */
  write: (relativePath: string, content: string) => void
}

/** A disposable directory with no `.git` anywhere below it. */
export interface TempDir {
  dir: string
  cleanup: () => void
}

/** Create a temporary directory outside any repository. */
export function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-git-plain-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Create a temporary git repository with a committed README. */
export function makeTempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-git-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'initial commit'])
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    git,
    write: (relativePath, content) => writeFileSync(join(dir, relativePath), content),
  }
}

/** Create a temporary git repository with no commits (unborn branch). */
export function makeUnbornRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-git-unborn-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    git,
    write: (relativePath, content) => writeFileSync(join(dir, relativePath), content),
  }
}

/** Create a disposable bare repository usable as a remote. */
export function makeBareRepo(): { dir: string; cleanup: () => void; git: (args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-git-bare-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '--bare', '-b', 'main'])
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    git,
  }
}

/** Clone a repository into a fresh disposable working repo. */
export function makeClone(sourceDir: string): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-git-clone-'))
  execFileSync('git', ['clone', sourceDir, dir], { encoding: 'utf8', stdio: 'pipe' })
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git(['config', 'user.name', 'Test User'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    git,
    write: (relativePath, content) => writeFileSync(join(dir, relativePath), content),
  }
}

/** Full host config the schemastery defaults would produce. */
const DEFAULT_CONFIG: gitPlugin.Config = {
  gitPath: 'git',
  destructivePolicy: 'deny',
  extraDestructivePatterns: [],
  logMaxCommits: 20,
  diffContextLines: 3,
}

/** Boot options: host config, the session cwd exposed to tool calls, and whether to load the tools row. */
export interface SetupOptions extends Partial<gitPlugin.Config> {
  /**
   * The session cwd the tools see as `exec.agent.session.header.cwd`. Required
   * for tool calls; there is no process-cwd fallback anymore.
   */
  cwd?: string
  /** Load the `dsh-tool-git/tools` row as well as the host row (default true). */
  withTools?: boolean
}

/** Session cwd per booted context, so existing call sites stay terse. */
const sessionCwds = new WeakMap<Context, string>()

/**
 * Boot a context with SystemPrompt + ToolRuntime + the git host row, and by
 * default the `/tools` row on top.
 */
export async function setupPlugin(options: SetupOptions = {}): Promise<Context> {
  const { cwd, withTools = true, ...config } = options
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(gitPlugin, { ...DEFAULT_CONFIG, ...config })
  if (withTools) await ctx.plugin(toolsEntry)
  if (cwd !== undefined) sessionCwds.set(ctx, cwd)
  return ctx
}

/** Boot the host row only (no model tools), to prove the split holds. */
export function setupHostOnly(options: SetupOptions = {}): Promise<Context> {
  return setupPlugin({ ...options, withTools: false })
}

/**
 * Boot the `/tools` row **without** the host row, to prove it fails closed:
 * its `gitContext` injection is unmet, so it registers nothing.
 */
export async function setupToolsOnly(cwd?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(toolsEntry)
  if (cwd !== undefined) sessionCwds.set(ctx, cwd)
  return ctx
}

/** Invoke a registered tool through the full pipeline as one agent session. */
export async function callTool(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  cwd?: string,
): Promise<ToolExecutionResult> {
  const sessionCwd = cwd ?? sessionCwds.get(ctx)
  if (sessionCwd === undefined) {
    throw new Error('test helper: pass setupPlugin({ cwd }) or callTool(…, cwd) to set the session cwd')
  }
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'test-call' as never,
    name,
    arguments: args,
    agent: { session: { header: { cwd: sessionCwd } } },
  })
}
