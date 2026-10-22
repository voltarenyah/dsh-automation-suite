/**
 * The `gitContext` service: git repository resolution as a reusable capability.
 *
 * The service is registered by the package's host entry so that sibling
 * plugins (notably the engineering-context plugin) can consume it through
 * `ctx.get('gitContext')` without importing this package's model-facing tools.
 *
 * Every method takes its root **explicitly**. The service never reads or uses
 * `process.cwd()` — not even as a spawn directory: a `git` subprocess always
 * runs in the caller-supplied root (or in `-C <root>` for discovery), because
 * `process.cwd()` may be a directory the user never chose and silently
 * operating there is exactly the trap this service exists to remove.
 *
 * @module dsh-tool-git/service
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { GitError, runGit } from './runner.ts'

/** Per-invocation knobs. `signal` aborts a long-running `git` process. */
export interface GitInvokeOptions {
  /** Cancels the subprocess. */
  signal?: AbortSignal
}

/** The raw outcome of one `git` invocation. A non-zero `code` is data. */
export interface GitCommandResult {
  /** Process exit code. */
  code: number
  /** Raw stdout, decoded as UTF-8. */
  stdout: string
  /** Raw stderr, decoded as UTF-8. */
  stderr: string
}

/** A repository-bound git context returned by {@link GitContextService.create}. */
export interface GitContext {
  /** Absolute repository root (the `git rev-parse --show-toplevel` result). */
  readonly repoDir: string
  /**
   * Run `git` in the repository root and return its outcome as data. A
   * non-zero exit code is returned, never thrown; only a missing `git`
   * executable or an abort rejects.
   */
  run(args: string[], options?: GitInvokeOptions): Promise<GitCommandResult>
  /**
   * Run `git` in the repository root and require a zero exit code.
   * @throws {@link GitError} when the exit code is non-zero.
   */
  runChecked(args: string[], options?: GitInvokeOptions): Promise<{ stdout: string; stderr: string }>
  /**
   * `git status --porcelain` lines, untracked entries included. When `paths`
   * is non-empty the query is limited to those repo-root-relative paths.
   * Each returned entry is one porcelain line (`XY path`).
   */
  status(paths: string[], options?: GitInvokeOptions): Promise<string[]>
  /** The `HEAD` commit hash, or `null` on an unborn branch. */
  head(options?: GitInvokeOptions): Promise<string | null>
  /**
   * Path-limited add-and-commit: stage `paths` (when non-empty), then commit
   * them (or the whole index when `paths` is empty). A clean tree yields
   * `{ committed: false, hash: null }` instead of throwing.
   */
  commit(
    paths: string[],
    message: string,
    options?: GitInvokeOptions,
  ): Promise<{ committed: boolean; hash: string | null }>
}

/** Defaults the model-facing tools read from the host row's configuration. */
export interface GitToolDefaults {
  /** Default commit count for `git_log` when the caller omits `maxCount`. */
  readonly logMaxCommits: number
  /** Default unified-diff context lines for `git_diff` / `git_show`. */
  readonly diffContextLines: number
}

/** The `gitContext` service registered by the host entry. */
export interface GitContextService {
  /** Tool defaults copied from the host row (the `/tools` row defines no config). */
  readonly defaults: GitToolDefaults
  /** True when `root` is inside a git working tree (at it or above it). */
  isRepository(root: string): Promise<boolean>
  /**
   * The `git rev-parse --show-toplevel` root at or above `root`, or `null`
   * when `root` is not inside a working tree (including a bare repository or
   * a path that does not exist).
   */
  repoRoot(root: string): Promise<string | null>
  /**
   * Bind a git context to the repository containing `root`.
   * @throws when `root` is not inside a git working tree.
   */
  create(root: string): Promise<GitContext>
  /**
   * Initialize a fresh repository at `root` (which must already exist) and
   * return its bound context. Used by sibling plugins that create a project
   * directory and then need their own repository — never by the model tools.
   * @param root - explicit, absolute directory to initialize.
   * @param options - `initialBranch` defaults to `main`.
   * @throws when `root` is missing, not a directory, or `git init` fails.
   */
  init(root: string, options?: GitInitOptions): Promise<GitContext>
}

/** Options for {@link GitContextService.init}. */
export interface GitInitOptions {
  /** Initial branch name. Defaults to `main` (passed as `git init -b`). */
  initialBranch?: string
}

/** Options for {@link createGitContextService}. */
export interface GitContextServiceOptions extends GitToolDefaults {
  /** The `git` executable to invoke. */
  gitPath: string
}

/**
 * Normalize and validate an explicit root argument.
 * @param root - caller-supplied directory.
 * @returns the normalized absolute path.
 * @throws when the argument is empty or relative (relative would reintroduce
 * the process-cwd trap).
 */
function normalizeRoot(root: string): string {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('gitContext: root must be a non-empty absolute directory path')
  }
  if (!isAbsolute(root)) {
    throw new TypeError(`gitContext: root must be absolute, got ${JSON.stringify(root)}`)
  }
  return resolve(root)
}

/** True when `path` exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Run `git` and capture a non-zero exit as data.
 * @param gitPath - the `git` executable.
 * @param args - argument array; never shell-interpreted.
 * @param cwd - spawn directory (always an explicit, caller-derived path).
 * @param options - cancellation signal.
 * @returns the outcome, including non-zero exit codes.
 */
async function runRaw(
  gitPath: string,
  args: string[],
  cwd: string,
  options?: GitInvokeOptions,
): Promise<GitCommandResult> {
  try {
    const result = await runGit(gitPath, args, {
      cwd,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    // runGit rejects for non-zero exits (GitError) as well as ENOENT/abort.
    // Only the former is an expected outcome; everything else is a real failure.
    if (error instanceof GitError) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
    throw error
  }
}

/**
 * Run `git` and require a zero exit code.
 * @param gitPath - the `git` executable.
 * @param args - argument array.
 * @param cwd - explicit spawn directory.
 * @param options - cancellation signal.
 * @returns the outcome of the successful invocation.
 * @throws {@link GitError} when the exit code is non-zero.
 */
async function runCheckedAt(
  gitPath: string,
  args: string[],
  cwd: string,
  options?: GitInvokeOptions,
): Promise<GitCommandResult> {
  const result = await runRaw(gitPath, args, cwd, options)
  if (result.code !== 0) {
    throw new GitError(
      result.stderr.trim()
        || result.stdout.trim()
        || `git ${args.join(' ')} exited with code ${result.code}`,
      result.code,
      result.stderr,
      result.stdout,
    )
  }
  return result
}

/**
 * Resolve the working-tree root at or above `root` without touching
 * `process.cwd()`.
 * @param gitPath - the `git` executable.
 * @param root - explicit directory to start from.
 * @returns the absolute root, or `null` outside a working tree.
 */
async function findRepoRoot(gitPath: string, root: string): Promise<string | null> {
  const dir = normalizeRoot(root)
  // `git -C` fails cleanly for a missing directory, but a missing cwd makes
  // execFile itself fail with ENOENT, which would be indistinguishable from a
  // missing git executable. Probe first and treat absence as "not a repository".
  if (!(await isDirectory(dir))) return null
  const result = await runRaw(gitPath, ['-C', dir, 'rev-parse', '--show-toplevel'], dir)
  if (result.code !== 0) return null
  const top = result.stdout.trim()
  return top.length === 0 ? null : resolve(top)
}

/** Build a repository-bound git context. */
function makeGitContext(gitPath: string, repoDir: string): GitContext {
  const run = (args: string[], options?: GitInvokeOptions): Promise<GitCommandResult> =>
    runRaw(gitPath, args, repoDir, options)

  const runChecked = async (
    args: string[],
    options?: GitInvokeOptions,
  ): Promise<{ stdout: string; stderr: string }> => {
    const result = await run(args, options)
    if (result.code !== 0) {
      throw new GitError(
        result.stderr.trim()
          || result.stdout.trim()
          || `git ${args.join(' ')} exited with code ${result.code}`,
        result.code,
        result.stderr,
        result.stdout,
      )
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  const head = async (options?: GitInvokeOptions): Promise<string | null> => {
    const result = await run(['rev-parse', '--verify', 'HEAD'], options)
    if (result.code !== 0) return null
    const hash = result.stdout.trim()
    return hash.length === 0 ? null : hash
  }

  return {
    repoDir,
    run,
    runChecked,
    async status(paths, options) {
      const args = ['status', '--porcelain']
      const clean = (paths ?? []).filter(path => typeof path === 'string' && path.length > 0)
      if (clean.length > 0) args.push('--', ...clean)
      const { stdout } = await runChecked(args, options)
      return stdout.split('\n').filter(line => line.length > 0)
    },
    head,
    async commit(paths, message, options) {
      const text = typeof message === 'string' ? message.trim() : ''
      if (text.length === 0) {
        throw new Error('gitContext.commit: message must be a non-empty string')
      }
      const clean = (paths ?? []).filter(path => typeof path === 'string' && path.length > 0)
      if (clean.length > 0) await runChecked(['add', '--', ...clean], options)
      const commitArgs = ['commit', '-m', text]
      if (clean.length > 0) commitArgs.push('--', ...clean)
      const result = await run(commitArgs, options)
      if (result.code !== 0) {
        if (result.code === 1 && /nothing to commit|no changes added|nothing added to commit/i.test(
          result.stderr + result.stdout,
        )) {
          return { committed: false, hash: null }
        }
        throw new GitError(
          result.stderr.trim()
            || result.stdout.trim()
            || `git commit exited with code ${result.code}`,
          result.code,
          result.stderr,
          result.stdout,
        )
      }
      return { committed: true, hash: await head(options) }
    },
  }
}

/**
 * Create the `gitContext` service value.
 * @param options - the `git` executable plus the tool defaults copied from the
 * host row's configuration.
 * @returns the service, ready to pass to `ctx.provide('gitContext', …)`.
 */
export function createGitContextService(options: GitContextServiceOptions): GitContextService {
  return {
    defaults: Object.freeze({
      logMaxCommits: options.logMaxCommits,
      diffContextLines: options.diffContextLines,
    }),
    async isRepository(root) {
      return (await findRepoRoot(options.gitPath, root)) !== null
    },
    repoRoot(root) {
      return findRepoRoot(options.gitPath, root)
    },
    async create(root) {
      const dir = normalizeRoot(root)
      const repoDir = await findRepoRoot(options.gitPath, dir)
      if (repoDir === null) {
        throw new Error(`not inside a git repository: ${dir}`)
      }
      return makeGitContext(options.gitPath, repoDir)
    },
    async init(root, initOptions) {
      const dir = normalizeRoot(root)
      if (!(await isDirectory(dir))) {
        throw new Error(`gitContext.init: root is not an existing directory: ${dir}`)
      }
      const branch = initOptions?.initialBranch ?? 'main'
      if (typeof branch !== 'string' || branch.trim().length === 0) {
        throw new TypeError('gitContext.init: initialBranch must be a non-empty string')
      }
      await runCheckedAt(options.gitPath, ['init', '-b', branch.trim()], dir)
      const repoDir = await findRepoRoot(options.gitPath, dir)
      if (repoDir === null) {
        throw new Error(`gitContext.init: git init did not produce a repository at ${dir}`)
      }
      return makeGitContext(options.gitPath, repoDir)
    },
  }
}
