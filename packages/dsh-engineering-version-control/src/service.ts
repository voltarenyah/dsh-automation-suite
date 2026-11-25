/**
 * The `versionControl` service: the one thing another plugin is allowed to call.
 *
 * `engineering-context` imports a project and then needs history for it. Two
 * calls, and only two:
 *
 * - {@link planBaseline} answers "may I record here, and what would the plan say"
 *   **before anything is opened or written** — a workspace nested inside somebody
 *   else's repository must be refused while a dry run is still a dry run;
 * - {@link recordBaseline} writes the ownership marker, initializes or reuses the
 *   repository, creates the one baseline commit of the import, and replays it into
 *   the version store.
 *
 * Everything that can fail is reported as this package's coded errors
 * (`workspace_is_repository`, `git_failed`, `git_access_unavailable`), so the
 * caller can put the code in front of the user without translating prose.
 *
 * **Why the marker still says `engineering-context`** (`git-context.ts`): the
 * marker is the on-disk identity of the *workflow*, not of the package. A
 * workspace created before this split carries that value, and refusing it would
 * make every existing workspace look foreign. Renaming it needs a migration, not
 * a string change.
 *
 * @module dsh-engineering-version-control/service
 */

import type { Context, Logger } from '@deepseek-ai/cordis'

import { type PluginConfig } from './config.js'
import type { DeviceInfo } from './device.js'
import { EngineeringContextError } from './errors.js'
import { commitMeta } from './git.js'
import {
  gitContextService,
  hasCreateTrailer,
  lastCommitBody,
  readRepoMarker,
  repoMarkerPath,
  writeRepoMarker,
  type GitContextServiceLike,
} from './git-context.js'
import { toPortable } from './paths.js'
import { indexDocuments } from './version/docs.js'
import { openVersionStore } from './version/store.js'
import { recordCommitAfterWrite } from './version/write.js'

/** The cordis service name other plugins look up. */
export const VERSION_CONTROL_SERVICE = 'versionControl'

/** The PLC a baseline belongs to. */
export interface BaselineDevice {
  device: string
  software: string
  directory: string
}

/** What the caller asks before doing any work. */
export interface BaselinePlanRequest {
  workspace: string
  /** The caller's layout names, so the marker lands where it expects. */
  stateDirName?: string
  sourceDirName?: string
}

/** The preflight result, plus the sentence a dry run can print. */
export interface BaselinePlan {
  state: 'none' | 'reuse'
  initialize: boolean
  repoRoot: string | null
  description: string
}

/** One baseline commit to record. */
export interface BaselineRequest extends BaselinePlanRequest {
  /** Absolute path of the exported source tree. */
  sourceRoot: string
  device: BaselineDevice
  /** Project or workspace name, used in the commit's subject line. */
  label: string
  /** The trailer value, already joined by the caller (`a,b` or `unknown`). */
  checksum: string
  stateId: string
}

/** What the baseline commit did, and what the derived indexes said. */
export interface BaselineResult {
  /** Repository root git reported. */
  root: string
  initialized: boolean
  committed: boolean
  hash: string | null
  /** One line for the version store, or null when nothing was recorded. */
  versionNote: string | null
  /** Derived-index problems: they never fail the import. */
  warnings: string[]
}

/** The service other plugins consume. */
export interface VersionControlLike {
  planBaseline(request: BaselinePlanRequest): Promise<BaselinePlan>
  recordBaseline(request: BaselineRequest): Promise<BaselineResult>
}

/** The repository state found before anything is opened or written. */
interface RepositoryPreflight {
  state: 'none' | 'reuse'
  repoRoot: string | null
}

/** Path comparison that treats the spellings Windows reports as the same directory. */
function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
  return normalize(left) === normalize(right)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The caller's layout names win over this plugin's defaults.
 *
 * Two plugins read the same workspace; if a profile moved `source/`, both must
 * agree on where it is. The caller knows, so it says.
 */
function effectiveConfig(base: PluginConfig, request: BaselinePlanRequest): PluginConfig {
  return {
    ...base,
    stateDirName: request.stateDirName ?? base.stateDirName,
    sourceDirName: request.sourceDirName ?? base.sourceDirName,
  }
}

/** The gitContext service, or the coded refusal the caller can surface. */
function requireGitService(ctx: Context): GitContextServiceLike {
  const service = gitContextService(ctx)
  if (service === undefined) {
    throw new EngineeringContextError(
      'git_access_unavailable',
      'This composition has no gitContext service, so the workspace repository state cannot be established. Install the ' +
        '@automation-suite/dsh-tool-git plugin (its host row) in this profile — history is written only through it.',
      { service: 'gitContext' },
    )
  }
  return service
}

/**
 * Decide whether this workspace may be initialized and committed into.
 *
 * Three answers, and only one of them allows the call to proceed:
 *
 *   - **no repository** — allowed; the baseline initializes one.
 *   - **a repository rooted here that this workflow created** — allowed; recognized
 *     by the local marker (written before the baseline commit) or by the
 *     `Tia-Op: create` trailer in the history.
 *   - **anything else** — refused with `workspace_is_repository`.
 *
 * @param service - the `gitContext` service.
 * @param root - the canonical workspace root.
 * @param config - the effective configuration (for the marker's location).
 * @returns what the repository state is.
 */
async function preflightRepository(
  service: GitContextServiceLike,
  root: string,
  config: PluginConfig,
): Promise<RepositoryPreflight> {
  const repoRoot = await service.repoRoot(root)
  if (repoRoot === null) return { state: 'none', repoRoot: null }
  if (!sameDirectory(repoRoot, root)) {
    throw new EngineeringContextError(
      'workspace_is_repository',
      `The workspace ${root} is inside the git repository at ${repoRoot}. Use a standalone directory: this workflow never ` +
        'initializes inside a foreign repository, and it will not add a baseline commit to a history it did not create.',
      { workspace: root, repoRoot },
    )
  }
  if ((await readRepoMarker(config, root)) !== null) return { state: 'reuse', repoRoot }
  if (hasCreateTrailer(await lastCommitBody(service, root))) return { state: 'reuse', repoRoot }
  throw new EngineeringContextError(
    'workspace_is_repository',
    `The workspace ${root} is already a git repository, but this workflow cannot attribute it: its last commit carries no ` +
      `"Tia-Op: create" trailer and there is no ${toPortable(root, repoMarkerPath(config, root))} marker. Use a standalone ` +
      'directory: it never initializes inside a foreign repository, and it will not append a baseline to a history ' +
      'it did not create.',
    { workspace: root, repoRoot, marker: toPortable(root, repoMarkerPath(config, root)) },
  )
}

/** What the plan says about git, before anything is written. */
function describeRepositoryPlan(root: string, config: PluginConfig, preflight: RepositoryPreflight): string {
  const paths = `${config.sourceDirName}/, .gitignore and .gitattributes`
  if (preflight.state === 'none') {
    return (
      `Git: ${root} is not a repository yet — it will be initialized (git init -b main) after the import, and a baseline ` +
      `commit will be created for ${paths}.`
    )
  }
  return `Git: reusing this workflow's repository at ${root} — a baseline commit will be created for ${paths}.`
}

/** The commit message: one summary line plus the four trailers the workflow reads. */
function baselineMessage(label: string, checksum: string, stateId: string): string {
  return [
    `create: ${label} — baseline import of the exported source tree`,
    '',
    'Tia-Op: create',
    `Tia-Checksum: ${checksum}`,
    `Tia-State: ${stateId}`,
    'Tia-Manifest: rebuilt',
  ].join('\n')
}

/**
 * Build the service.
 *
 * @param ctx - the plugin context (for `gitContext`, and for the logger).
 * @param base - this plugin's resolved configuration.
 * @returns the two calls another plugin may make.
 */
export function createVersionControlService(ctx: Context, base: PluginConfig): VersionControlLike {
  const log: Logger = ctx.logger('version-control')

  return {
    async planBaseline(request) {
      const config = effectiveConfig(base, request)
      const service = requireGitService(ctx)
      const preflight = await preflightRepository(service, request.workspace, config)
      return {
        state: preflight.state,
        initialize: preflight.state === 'none',
        repoRoot: preflight.repoRoot,
        description: describeRepositoryPlan(request.workspace, config, preflight),
      }
    },

    async recordBaseline(request) {
      const config = effectiveConfig(base, request)
      const service = requireGitService(ctx)
      const root = request.workspace
      const preflight = await preflightRepository(service, root, config)
      const paths = ['.gitignore', '.gitattributes', config.sourceDirName]
      const marker = toPortable(root, repoMarkerPath(config, root))
      const failure = (cause: unknown, initialized: boolean): EngineeringContextError =>
        new EngineeringContextError(
          'git_failed',
          `The project was imported, but the git baseline could not be created: ${messageOf(cause)}. In this workspace the ` +
            `source tree (${toPortable(root, request.sourceRoot)}/) and its evidence ledger are already written. Fix the git ` +
            `problem and call the import again — the marker ${marker} lets the retry recognize the repository as this ` +
            "workflow's instead of refusing it as foreign.",
          {
            root,
            paths,
            sourceRoot: toPortable(root, request.sourceRoot),
            marker,
            initialized,
            cause: messageOf(cause),
          },
        )

      // First, on purpose: a half-finished commit must not make the repository
      // look foreign to the next call.
      await writeRepoMarker(config, root)

      const initialized = preflight.state === 'none'
      let git
      try {
        git = initialized ? await service.init(root) : await service.create(root)
      } catch (error) {
        throw failure(error, initialized)
      }

      let commit: { committed: boolean; hash: string | null }
      try {
        commit = await git.commit(paths, baselineMessage(request.label, request.checksum, request.stateId))
      } catch (error) {
        throw failure(error, initialized)
      }

      const warnings: string[] = []
      let versionNote: string | null = null
      if (commit.committed && commit.hash !== null) {
        try {
          const meta = await commitMeta(root, commit.hash)
          if (meta !== null) {
            const device: DeviceInfo = { ...request.device, sourceRoot: request.sourceRoot }
            const written = await recordCommitAfterWrite({
              root,
              config,
              device,
              commit: meta,
              sessionId: null,
              bundleDir: null,
              log,
            })
            versionNote =
              written === null
                ? 'already recorded'
                : written.replayed === true
                  ? 'history replayed'
                  : `${written.events} change event(s)`
            const store = openVersionStore(config, root)
            try {
              const docs = await indexDocuments({ store, config, root })
              if (docs.indexed > 0) versionNote = `${versionNote}; ${docs.indexed} document(s) indexed`
            } finally {
              store.close()
            }
          }
        } catch (error) {
          warnings.push(
            `The version store was not initialized (the import itself is complete): ${messageOf(error)}`,
          )
        }
      }

      return {
        root: git.repoDir,
        initialized,
        committed: commit.committed,
        hash: commit.hash,
        versionNote,
        warnings,
      }
    },
  }
}

/** The service when this composition has it, else undefined. */
export function versionControl(ctx: Context): VersionControlLike | undefined {
  const service = ctx.get(VERSION_CONTROL_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  for (const member of ['planBaseline', 'recordBaseline']) {
    if (typeof candidate[member] !== 'function') return undefined
  }
  return service as VersionControlLike
}
