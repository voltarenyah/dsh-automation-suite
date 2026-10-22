/**
 * The `gitContext` seam: the workspace repository, as the `dsh-tool-git` plugin
 * exposes it.
 *
 * This plugin runs git itself for the sync workflow (`git.ts`), but it does not
 * invent a repository: initializing one is a decision the git plugin owns and
 * exposes as a service (`isRepository` / `repoRoot` / `create` / `init`). The
 * service is looked up **by name**, never imported (docs/decisions.md D10), and
 * every call takes an explicit absolute root — the service never reads
 * `process.cwd()`, and neither does this module.
 *
 * The other half of this module is the **ownership marker** under
 * `<workspace>/.dsh/local/repo.json`. It answers "may this plugin commit here?"
 * for a repository it created itself: the marker is written before the baseline
 * commit, so a commit that failed half-way does not leave a repository that the
 * next call would mistake for somebody else's.
 *
 * @module dsh-engineering-context/git-context
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { localStateDirectoryPath, type PluginConfig } from './config.js'

/** The service name the git plugin registers. Not an import, by design (D10). */
export const GIT_CONTEXT_SERVICE = 'gitContext'

/** The raw outcome of one `git` invocation. A non-zero `code` is data. */
export interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

/** A repository-bound git context, reduced to what this plugin calls. */
export interface GitContextLike {
  /** Absolute repository root. */
  readonly repoDir: string
  /** Runs git in the repository root; a non-zero exit is data, not an exception. */
  run(args: string[]): Promise<GitCommandResult>
  /** Runs git in the repository root and throws on a non-zero exit. */
  runChecked(args: string[]): Promise<{ stdout: string; stderr: string }>
  /** `git status --porcelain` lines, untracked included. */
  status(paths: string[]): Promise<string[]>
  /** The HEAD commit, or null on an unborn branch. */
  head(): Promise<string | null>
  /** Path-limited add-and-commit; a clean tree yields `committed: false`. */
  commit(paths: string[], message: string): Promise<{ committed: boolean; hash: string | null }>
}

/**
 * The members of the `gitContext` service this plugin uses.
 *
 * `init` is deliberately used only by `create_engineering_project`: the sync and
 * status tools keep refusing to work outside an existing repository.
 */
export interface GitContextServiceLike {
  isRepository(root: string): Promise<boolean>
  repoRoot(root: string): Promise<string | null>
  create(root: string): Promise<GitContextLike>
  init(root: string, options?: { initialBranch?: string }): Promise<GitContextLike>
}

/**
 * The host's `gitContext` service, or `undefined` when this composition has none.
 *
 * A composition without the git plugin is legitimate for the read-only tools but
 * not for `create_engineering_project`, which needs the service to establish the
 * repository state before it opens anything.
 *
 * @param ctx - the plugin context.
 * @returns the service, when it is present and looks usable.
 */
export function gitContextService(ctx: Context): GitContextServiceLike | undefined {
  const service = ctx.get(GIT_CONTEXT_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['isRepository', 'repoRoot', 'create', 'init']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as unknown as GitContextServiceLike
}

/** File name of the ownership marker, inside the workspace's local state directory. */
export const REPO_MARKER_FILE = 'repo.json'

/** The marker's schema version; a marker with another version is not trusted. */
export const REPO_MARKER_SCHEMA_VERSION = 1

/** The `createdBy` value that marks a repository as created by this plugin. */
export const REPO_MARKER_CREATED_BY = 'engineering-context'

/** The marker document, as it is written to disk. */
export interface RepoMarker {
  schemaVersion: number
  createdBy: string
}

/**
 * Absolute path of the ownership marker of one workspace.
 *
 * It lives under the **local state** directory, which the workspace `.gitignore`
 * excludes: the marker is local evidence about the repository, not content that
 * belongs in a commit.
 *
 * @param config - the resolved configuration.
 * @param workspaceRoot - the canonical workspace root.
 */
export function repoMarkerPath(config: PluginConfig, workspaceRoot: string): string {
  return join(localStateDirectoryPath(config, workspaceRoot), REPO_MARKER_FILE)
}

/**
 * Read the ownership marker of one workspace.
 *
 * A missing, unreadable, malformed or differently-versioned marker is reported as
 * **absent**: unreadable evidence must never be read as a claim of ownership.
 *
 * @param config - the resolved configuration.
 * @param workspaceRoot - the canonical workspace root.
 * @returns the marker, or null when there is no usable one.
 */
export async function readRepoMarker(config: PluginConfig, workspaceRoot: string): Promise<RepoMarker | null> {
  let raw: string
  try {
    raw = await readFile(repoMarkerPath(config, workspaceRoot), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; createdBy?: unknown }
    if (parsed.schemaVersion !== REPO_MARKER_SCHEMA_VERSION) return null
    if (parsed.createdBy !== REPO_MARKER_CREATED_BY) return null
    return { schemaVersion: REPO_MARKER_SCHEMA_VERSION, createdBy: REPO_MARKER_CREATED_BY }
  } catch {
    return null
  }
}

/**
 * Write the ownership marker **before** the baseline commit.
 *
 * Writing it first is the whole point: if `git commit` fails, the repository is
 * already marked as this plugin's, so a retry is allowed to reuse it instead of
 * being refused as a foreign repository.
 *
 * @param config - the resolved configuration.
 * @param workspaceRoot - the canonical workspace root.
 * @returns the absolute path that was written.
 */
export async function writeRepoMarker(config: PluginConfig, workspaceRoot: string): Promise<string> {
  const file = repoMarkerPath(config, workspaceRoot)
  await mkdir(dirname(file), { recursive: true })
  const document: RepoMarker = {
    schemaVersion: REPO_MARKER_SCHEMA_VERSION,
    createdBy: REPO_MARKER_CREATED_BY,
  }
  await writeFile(file, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
  return file
}

/**
 * The body of the repository's last commit, or null when there is none.
 *
 * @param service - the `gitContext` service.
 * @param root - the workspace root.
 */
export async function lastCommitBody(
  service: GitContextServiceLike,
  root: string,
): Promise<string | null> {
  try {
    const git = await service.create(root)
    const result = await git.run(['log', '-1', '--format=%B'])
    return result.code === 0 ? result.stdout : null
  } catch {
    // No commit yet, no usable repository, or no git executable: all three mean
    // "this repository carries no evidence of a create baseline".
    return null
  }
}

/**
 * Whether a commit body carries the trailer `create_engineering_project` writes.
 *
 * The trailer is what makes a repository recognizable as this plugin's even after
 * the local marker was deleted: the history itself says who created it.
 *
 * @param body - the last commit body, or null.
 */
export function hasCreateTrailer(body: string | null): boolean {
  if (body === null) return false
  return body.split(/\r?\n/u).some((line) => line.trim() === 'Tia-Op: create')
}
