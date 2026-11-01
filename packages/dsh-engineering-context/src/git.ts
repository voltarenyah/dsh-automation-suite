/**
 * Shell-free git access.
 *
 * The plugin runs git itself — the model never does (A8/D8). Arguments are an
 * explicit array, the repository is passed with `-C`, and the environment keeps
 * git from prompting: the same rules the repository's `dsh-tool-git` runner uses.
 *
 * Only the small surface the sync workflow needs is here: locate the repository,
 * read the status of one device directory, stage that directory and commit it.
 * There is no `reset`, `--force`, `rebase` or `push`.
 *
 * @module dsh-engineering-context/git
 */

import { execFile } from 'node:child_process'
import { relative } from 'node:path'
import { promisify } from 'node:util'

import { EngineeringContextError } from './errors.js'

const execFileAsync = promisify(execFile)

/** One git invocation, with its exit code instead of an exception for non-zero. */
export interface GitRun {
  code: number
  stdout: string
  stderr: string
}

/** A commit that was actually created. */
export interface GitCommit {
  committed: boolean
  hash: string | null
}

/**
 * Run git in one repository.
 *
 * A non-zero exit is **data**: "this directory is not a repository" is a state,
 * not a crash. Only a missing executable is turned into an error, because there
 * is no meaningful result to report.
 */
export async function runGit(root: string, args: readonly string[]): Promise<GitRun> {
  try {
    const result = (await execFileAsync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })) as { stdout: string; stderr: string }
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: string | number
      stdout?: string
      stderr?: string
      status?: number
    }
    if (failure.code === 'ENOENT') {
      throw new EngineeringContextError('git_failed', 'The git executable was not found on PATH.', { root })
    }
    const code = typeof failure.code === 'number' ? failure.code : (failure.status ?? 1)
    return { code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * The repository root that contains the workspace, or a coded refusal.
 *
 * This plugin never runs `git init` (D13): creating history in somebody's
 * directory is a side effect they did not ask for.
 */
export async function ensureRepository(root: string): Promise<string> {
  const result = await runGit(root, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) {
    throw new EngineeringContextError(
      'repository_not_found',
      `${root} is not inside a git repository. This plugin never creates one: run "git init" in the workspace (or its parent) first.`,
      { workspace: root, stderr: result.stderr.trim() },
    )
  }
  return result.stdout.trim()
}

/** The porcelain status lines of the given paths (untracked files included). */
export async function statusPaths(root: string, paths: readonly string[]): Promise<string[]> {
  const result = await runGit(root, ['status', '--porcelain', '--', ...paths])
  if (result.code !== 0) {
    throw new EngineeringContextError('git_failed', 'git status failed.', {
      root,
      paths,
      stderr: result.stderr.trim(),
    })
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/**
 * The file paths out of `git status --porcelain` lines.
 *
 * Each line is `XY path`, and a rename is `XY old -> new`; the model is shown
 * paths, not status codes, so both shapes are reduced to the path that exists
 * now. Kept separate from {@link statusPaths} because the status tool only needs
 * a count, while sync and commit quote the paths back to the model.
 *
 * @param lines - the raw porcelain lines.
 * @returns the workspace-relative paths, in the order git listed them.
 */
export function porcelainPaths(lines: readonly string[]): string[] {
  const paths: string[] = []
  for (const line of lines) {
    // "XY path": two status columns, one space, then the path.
    const body = line.length > 3 ? line.slice(3) : ''
    if (body.length === 0) continue
    const arrow = body.indexOf(' -> ')
    paths.push(arrow >= 0 ? body.slice(arrow + 4) : body)
  }
  return paths
}

/** The HEAD commit, or null on an unborn branch. */
export async function headCommit(root: string): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * Stage and commit exactly one path set.
 *
 * The pathspec is passed to both `git add` and `git commit`, so an unrelated
 * staged file elsewhere in the workspace can never ride along in this commit.
 */
export async function commitPaths(root: string, paths: readonly string[], message: string): Promise<GitCommit> {
  const before = await statusPaths(root, paths)
  if (before.length === 0) return { committed: false, hash: await headCommit(root) }

  const staged = await runGit(root, ['add', '--', ...paths])
  if (staged.code !== 0) {
    throw new EngineeringContextError('git_failed', 'git add failed.', {
      root,
      paths,
      stderr: staged.stderr.trim(),
    })
  }

  const afterAdd = await statusPaths(root, paths)
  if (afterAdd.length === 0) return { committed: false, hash: await headCommit(root) }

  const commit = await runGit(root, ['commit', '-m', message, '--', ...paths])
  if (commit.code !== 0) {
    throw new EngineeringContextError('git_failed', 'git commit failed.', {
      root,
      paths,
      stdout: commit.stdout.trim(),
      stderr: commit.stderr.trim(),
    })
  }
  return { committed: true, hash: await headCommit(root) }
}

/**
 * A path relative to the workspace root, spelled with forward slashes for git.
 *
 * @param root - the workspace root.
 * @param absolute - a path inside it.
 */
export function gitPath(root: string, absolute: string): string {
  return relative(root, absolute).replace(/\\/gu, '/')
}

// ---------------------------------------------------------------------------
// Read-only history access for the version store
// ---------------------------------------------------------------------------

/** One commit as `git log` reports it. */
export interface CommitMeta {
  sha: string
  parents: string[]
  committedAt: string
  subject: string
  body: string
}

/**
 * Read one commit's metadata.
 *
 * @param root - the workspace root.
 * @param revision - a commit or ref.
 * @returns the metadata, or null when the revision does not exist.
 */
export async function commitMeta(root: string, revision: string): Promise<CommitMeta | null> {
  const result = await runGit(root, ['show', '-s', '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b', revision])
  if (result.code !== 0) return null
  const fields = result.stdout.split('\x1f')
  const sha = (fields[0] ?? '').trim()
  if (sha.length === 0) return null
  return {
    sha,
    parents: (fields[1] ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0),
    committedAt: (fields[2] ?? '').trim(),
    subject: (fields[3] ?? '').trim(),
    body: (fields[4] ?? '').replace(/\s+$/u, ''),
  }
}

/**
 * Every commit of the repository, oldest first.
 *
 * Records are separated by `\x1e` and fields by `\x1f`, so multi-line bodies
 * survive; the repository's own ordering is kept, which is what a replay needs.
 *
 * @param root - the workspace root.
 * @returns the commits; an empty list when the directory is not a repository.
 */
export async function logCommits(root: string): Promise<CommitMeta[]> {
  const result = await runGit(root, ['log', '--reverse', '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e'])
  if (result.code !== 0) return []
  const commits: CommitMeta[] = []
  for (const record of result.stdout.split('\x1e')) {
    const text = record.replace(/^\r?\n/u, '')
    if (text.trim().length === 0) continue
    const fields = text.split('\x1f')
    const sha = (fields[0] ?? '').trim()
    if (sha.length === 0) continue
    commits.push({
      sha,
      parents: (fields[1] ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0),
      committedAt: (fields[2] ?? '').trim(),
      subject: (fields[3] ?? '').trim(),
      body: (fields[4] ?? '').replace(/\s+$/u, ''),
    })
  }
  return commits
}

/**
 * Read one file as it existed at one revision.
 *
 * @param root - the workspace root.
 * @param revision - a commit or ref.
 * @param relativePath - a workspace-relative path with forward slashes.
 * @returns the file text, or null when that revision has no such file.
 */
export async function showFileAtRevision(
  root: string,
  revision: string,
  relativePath: string,
): Promise<string | null> {
  const result = await runGit(root, ['show', `${revision}:${relativePath}`])
  return result.code === 0 ? result.stdout : null
}

/** Per-file line statistics between two revisions. */
export interface FileStat {
  added: number
  removed: number
}

/**
 * `git diff --numstat` between two revisions, restricted to paths.
 *
 * @param root - the workspace root.
 * @param from - the older revision.
 * @param to - the newer revision (`WORKTREE` is not supported here).
 * @param paths - path filters, relative to the workspace root.
 * @returns a map from workspace-relative path to line counts.
 */
export async function numstatBetween(
  root: string,
  from: string,
  to: string,
  paths: readonly string[],
): Promise<Map<string, FileStat>> {
  const result = await runGit(root, ['diff', '--numstat', from, to, '--', ...paths])
  const stats = new Map<string, FileStat>()
  if (result.code !== 0) return stats
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = Number(parts[0])
    const removed = Number(parts[1])
    const path = (parts[2] ?? '').replace(/\\/gu, '/')
    if (path.length === 0) continue
    stats.set(path, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    })
  }
  return stats
}
