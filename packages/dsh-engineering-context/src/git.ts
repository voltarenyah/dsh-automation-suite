/**
 * The internal git layer.
 *
 * Git is called from **inside the plugin**, never exposed to the model: the
 * arguments are assembled here and the repository root comes from the plugin's own
 * scope resolution, so there is no way for a caller to name the wrong path or drop
 * an argument (open-questions A8, decisions.md D8).
 *
 * The invocation style is copied from `dsh-tool-git`, the repository's working
 * precedent: `execFile` with an explicit argument array and no shell,
 * `core.quotepath=false` so non-ASCII paths stay readable, `--no-optional-locks`
 * so reads never take advisory locks, and prompts disabled so a credential or
 * editor question can never hang the host.
 *
 * Two rules this module exists to enforce:
 *
 *   1. **`.ap17` files never enter git.** The export tree and the plugin state are
 *      versioned; the binary project is not (its diffs would say "changed" and
 *      nothing else). `.gitignore` does that, and this module never adds a path
 *      outside the ones it was given.
 *   2. **This module never initializes a repository, never forces, never rewrites
 *      history and never pushes.** Those are all things the user does.
 *
 * @module dsh-engineering-context/git
 */

import { execFile } from 'node:child_process'

/** One completed `git` invocation. */
export interface GitRunResult {
  /** Raw stdout, decoded as UTF-8. */
  stdout: string
  /** Raw stderr, decoded as UTF-8. */
  stderr: string
  /** Process exit code. */
  code: number
}

/** A `git` invocation that exited non-zero. */
export class GitError extends Error {
  /** Process exit code. */
  readonly code: number
  /** Raw stderr from the failed invocation. */
  readonly stderr: string
  /** Raw stdout from the failed invocation. */
  readonly stdout: string

  constructor(message: string, code: number, stderr: string, stdout = '') {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
    this.stdout = stdout
  }
}

/** Where and how to run one command. */
export interface GitRunOptions {
  /** Working directory the subprocess runs in. */
  cwd: string
  /** Abort the subprocess when this signal fires. */
  signal?: AbortSignal
}

/**
 * Run `git` with an explicit argument array.
 *
 * A non-zero exit is **returned**, not thrown: several callers have to interpret
 * one as a state rather than a failure (`rev-parse --show-toplevel` outside a
 * repository, `rev-parse --verify HEAD` on an unborn branch). Anything that wants
 * the strict behaviour calls {@link runGitChecked} instead. Only a missing
 * executable or an aborted call rejects, because neither leaves a result to
 * interpret.
 *
 * @param gitPath - the executable to invoke (`git` on PATH by default).
 * @param args - arguments; never shell-interpreted.
 * @param options - working directory and cancellation.
 * @returns the raw result, with the exit code for the caller to judge.
 * @throws {GitError} when the executable is missing.
 */
export function runGit(gitPath: string, args: string[], options: GitRunOptions): Promise<GitRunResult> {
  const fullArgs = ['-c', 'core.quotepath=false', '--no-optional-locks', ...args]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never block on an interactive credential, editor or pager prompt.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      gitPath,
      fullArgs,
      {
        cwd: options.cwd,
        env,
        signal: options.signal,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const result: GitRunResult = {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code:
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 0,
        }
        if (error) {
          const errno = (error as NodeJS.ErrnoException).code
          if (errno === 'ENOENT') {
            reject(new GitError(`git executable not found: ${gitPath}`, -1, result.stderr))
            return
          }
          if (errno === 'ABORT_ERR') {
            reject(error)
            return
          }
          // A non-zero exit is data: hand back the code and both streams.
        }
        resolve(result)
      },
    )
  })
}

/**
 * Run `git` and require success.
 *
 * @param gitPath - the executable to invoke.
 * @param args - arguments.
 * @param options - working directory and cancellation.
 * @returns the raw result of the successful invocation.
 * @throws {GitError} when git exits non-zero.
 */
export async function runGitChecked(gitPath: string, args: string[], options: GitRunOptions): Promise<GitRunResult> {
  const result = await runGit(gitPath, args, options)
  if (result.code !== 0) {
    throw new GitError(
      result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} exited with code ${result.code}`,
      result.code,
      result.stderr,
      result.stdout,
    )
  }
  return result
}

/** The repository a workspace sits in, if any. */
export interface RepositoryState {
  /** True when the workspace is inside a git work tree. */
  isRepository: boolean
  /** The work-tree root git reported, when it is a repository. */
  root: string | null
  /**
   * True when `root` is inside (or equals) the workspace root. When it is false,
   * commits made here share history with unrelated content, which the caller must
   * report rather than hide.
   */
  insideWorkspace: boolean
}

/**
 * Locate the repository the workspace lives in.
 *
 * @param gitPath - the git executable.
 * @param workspaceRoot - canonical workspace root.
 * @param relativeRoot - whether `root` is inside the workspace (caller-supplied check).
 */
function stateFromToplevel(toplevel: string | null, workspaceRoot: string, isInside: (a: string, b: string) => boolean): RepositoryState {
  if (toplevel === null) return { isRepository: false, root: null, insideWorkspace: false }
  return { isRepository: true, root: toplevel, insideWorkspace: isInside(workspaceRoot, toplevel) }
}

/**
 * Ask git whether the workspace is a repository, and where its root is.
 *
 * `rev-parse --show-toplevel` writes an empty line and exits non-zero outside a
 * repository, which is a state, not a failure — so this never throws for it.
 *
 * @param gitPath - the git executable.
 * @param workspaceRoot - canonical workspace root, used as the working directory.
 * @param signal - cancellation.
 * @param isInside - the containment predicate from `paths.ts`.
 */
export async function repositoryState(
  gitPath: string,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
  isInside: (root: string, candidate: string) => boolean,
): Promise<RepositoryState> {
  const result = await runGit(gitPath, ['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, signal })
  if (result.code !== 0) return stateFromToplevel(null, workspaceRoot, isInside)
  const toplevel = result.stdout.trim()
  return stateFromToplevel(toplevel.length === 0 ? null : toplevel, workspaceRoot, isInside)
}

/**
 * The commit HEAD points at.
 *
 * @returns the full hash, or null when the repository has no commit yet.
 */
export async function headCommit(
  gitPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await runGit(gitPath, ['rev-parse', '--verify', 'HEAD'], { cwd, signal })
  if (result.code !== 0) return null
  const hash = result.stdout.trim()
  return hash.length === 0 ? null : hash
}

/**
 * The branch HEAD is on.
 *
 * @returns the branch name, or null on a detached HEAD or an unborn branch.
 */
export async function currentBranch(
  gitPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await runGit(gitPath, ['branch', '--show-current'], { cwd, signal })
  if (result.code !== 0) return null
  const branch = result.stdout.trim()
  return branch.length === 0 ? null : branch
}

/**
 * Paths with uncommitted changes, limited to the paths given.
 *
 * `--untracked-files=all` is deliberate: the default reports an untracked *directory*
 * as one line, which would hide exactly what a caller wants to know (which files
 * appeared in the export tree). The result is still bounded by the caller, because
 * a first export of a real project is over a thousand files.
 *
 * @param paths - repository-relative pathspecs (the plugin's own; never a caller's).
 * @returns the porcelain status lines, one per changed path.
 */
export async function changedPaths(
  gitPath: string,
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (paths.length === 0) return []
  const result = await runGit(gitPath, ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
    cwd,
    signal,
  })
  if (result.code !== 0) {
    throw new GitError(result.stderr.trim() || 'git status failed', result.code, result.stderr, result.stdout)
  }
  return result.stdout.split('\n').filter((line) => line.trim().length > 0)
}

/** One commit, as reported by {@link readLog}. */
export interface GitCommit {
  hash: string
  date: string
  subject: string
}

/**
 * Commits that touched the given paths, newest first.
 *
 * @param limit - maximum number of commits.
 */
export async function readLog(
  gitPath: string,
  cwd: string,
  paths: readonly string[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<GitCommit[]> {
  const args = ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%ad%x09%s', '--date=iso-strict']
  if (paths.length > 0) args.push('--', ...paths)
  const result = await runGit(gitPath, args, { cwd, signal })
  if (result.code !== 0) {
    // An unborn branch (no commit yet) is a state, not an error.
    if (/does not have any commits yet|unknown revision/u.test(result.stderr)) return []
    throw new GitError(result.stderr.trim() || 'git log failed', result.code, result.stderr, result.stdout)
  }
  const commits: GitCommit[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const [hash, date, ...rest] = line.split('\t')
    if (hash === undefined || date === undefined) continue
    commits.push({ hash, date, subject: rest.join('\t') })
  }
  return commits
}

/** One path changed between two revisions. */
export interface GitChangedFile {
  /** `A` added, `M` modified, `D` deleted, `R*` renamed, `C*` copied. */
  status: string
  path: string
}

/**
 * The files that differ between two revisions, limited to the given paths.
 *
 * @param from - the older revision (any git revision expression).
 * @param to - the newer revision.
 */
export async function diffNameStatus(
  gitPath: string,
  cwd: string,
  from: string,
  to: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ files: GitChangedFile[]; summary: string }> {
  const range = `${from}..${to}`
  const nameArgs = ['diff', '--name-status', range]
  const statArgs = ['diff', '--stat', range]
  if (paths.length > 0) {
    nameArgs.push('--', ...paths)
    statArgs.push('--', ...paths)
  }
  const nameResult = await runGitChecked(gitPath, nameArgs, { cwd, signal })
  const statResult = await runGit(gitPath, statArgs, { cwd, signal })

  const files: GitChangedFile[] = []
  for (const line of nameResult.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const parts = line.split('\t')
    const status = parts[0] ?? ''
    // Renames and copies report two paths; the new one is what a reader wants.
    const path = parts.length >= 3 ? (parts[2] ?? '') : (parts[1] ?? '')
    if (status.length === 0 || path.length === 0) continue
    files.push({ status: status.charAt(0), path })
  }
  return { files, summary: statResult.stdout.trim() }
}

/**
 * Write the full patch between two revisions to a file.
 *
 * The patch is an artifact, not a result: a real export tree produces megabytes of
 * diff, and the model gets the path plus a bounded preview instead
 * (docs/ARCHITECTURE.md §6, rule R2).
 *
 * @returns the patch text (the caller writes it; this module owns no storage).
 */
export async function diffPatch(
  gitPath: string,
  cwd: string,
  from: string,
  to: string,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const args = ['diff', `${from}..${to}`]
  if (paths.length > 0) args.push('--', ...paths)
  const result = await runGit(gitPath, args, { cwd, signal })
  if (result.code !== 0) {
    throw new GitError(result.stderr.trim() || 'git diff failed', result.code, result.stderr, result.stdout)
  }
  return result.stdout
}

/**
 * Stage exactly the given paths and commit them with a message.
 *
 * `git add` respects `.gitignore`, which is what keeps `.ap17` files out, and the
 * commit is path-limited so unrelated staged work is not swept into this commit.
 *
 * @returns the new commit hash, or null when there was nothing to commit.
 */
export async function commitPaths(
  gitPath: string,
  cwd: string,
  paths: readonly string[],
  message: string,
  signal: AbortSignal | undefined,
): Promise<{ hash: string | null; changed: string[] }> {
  if (paths.length === 0) throw new TypeError('commitPaths needs at least one path')
  if (message.trim().length === 0) throw new TypeError('commitPaths needs a non-empty message')

  const before = await changedPaths(gitPath, cwd, paths, signal)
  if (before.length === 0) return { hash: null, changed: [] }

  await runGitChecked(gitPath, ['add', '--', ...paths], { cwd, signal })
  const staged = await runGitChecked(gitPath, ['diff', '--cached', '--name-only', '--', ...paths], { cwd, signal })
  if (staged.stdout.trim().length === 0) return { hash: null, changed: [] }

  await runGitChecked(gitPath, ['commit', '--message', message, '--', ...paths], { cwd, signal })
  const hash = await headCommit(gitPath, cwd, signal)
  return { hash, changed: before }
}
