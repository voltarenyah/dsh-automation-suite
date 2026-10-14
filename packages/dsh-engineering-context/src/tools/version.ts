/**
 * `eng_version` — the version layer: what revision is this, what changed between
 * two of them, and putting the export tree into history.
 *
 * Four actions: `current`, `commit`, `log`, `diff`.
 *
 * What gets versioned is decided **here**, never by the caller: the project's
 * export directory and its state directory (`_dsh-eng/<id>/`). That is what makes
 * the commit and the diff "engineering" rather than arbitrary — and it is why the
 * `.ap17` never enters history (a binary project diff says "changed" and nothing
 * else; `.gitignore` keeps it out, decisions.md D4).
 *
 * `commit` defaults to `dry_run: true` and needs an explicit `dry_run: false`.
 * Committing is history: it is the one action here that a careless call would make
 * hard to walk back, so the default is the plan. The plugin never initializes a
 * repository, never forces, never rewrites history and never pushes (D13).
 *
 * @module dsh-engineering-context/tools/version
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import { projectStateDir } from '../config.js'
import { EngineeringContextError } from '../errors.js'
import {
  changedPaths,
  commitPaths,
  currentBranch,
  diffNameStatus,
  diffPatch,
  GitError,
  headCommit,
  readLog,
  repositoryState,
  type GitCommit,
} from '../git.js'
import { fromPortable, isInside } from '../paths.js'
import { requireProject, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, MAX_LISTED, okOutcome } from './outcome.js'

const VERSION_PARAMETERS = {
  action: {
    type: 'string',
    enum: ['current', 'commit', 'log', 'diff'],
    required: true,
    description:
      'current: which revision this workspace is at and what is uncommitted. commit: put the export tree and this ' +
      'project state into history (dry-run by default). log: recent commits that touched them. diff: what changed ' +
      'between two revisions.',
  },
  message: { type: 'string', description: 'commit: the commit message. Required when action=commit runs for real.' },
  limit: { type: 'integer', description: 'log: how many commits to return (default 10, at most 100).' },
  from: { type: 'string', description: 'diff: the older revision. Defaults to the parent of `to`.' },
  to: { type: 'string', description: 'diff: the newer revision. Defaults to HEAD.' },
  full: {
    type: 'boolean',
    description:
      'diff: also write the complete patch as an artifact and return its path (default false). A real export tree ' +
      'produces megabytes of diff, which belongs in a file rather than in your context.',
  },
  dry_run: {
    type: 'boolean',
    description: 'commit: default TRUE — report what would be committed. Pass false to actually commit.',
  },
} as const

type VersionArgs = InferArgs<typeof VERSION_PARAMETERS>

/** The repository-relative pathspecs this plugin versions. */
interface VersionedPaths {
  /** Pathspecs to hand git, relative to the workspace root (git runs there). */
  pathspecs: string[]
  /** Absolute paths, for the caller's benefit. */
  absolute: string[]
  /** Versioned paths that fall outside the repository root, if any. */
  outsideRepository: string[]
}

/**
 * Compute what is versioned for one project.
 *
 * A path outside the repository (possible when the workspace holds a nested
 * repository that does not cover the project directory) is reported rather than
 * silently dropped: "this is not versioned" is exactly the kind of thing a caller
 * must not have to guess.
 */
function versionedPaths(scope: ResolvedScope, repositoryRoot: string | null): VersionedPaths {
  const root = scope.workspace.path
  const project = requireProject(scope)
  const absolute = [
    fromPortable(root, project.export),
    fromPortable(root, projectStateDir(scope.config, project.id)),
  ]

  const pathspecs: string[] = []
  const outsideRepository: string[] = []
  for (const path of absolute) {
    const portable = relative(root, path).split('\\').join('/')
    if (repositoryRoot !== null) {
      const fromRepo = relative(repositoryRoot, path)
      if (fromRepo.startsWith('..') || fromRepo.length === 0) {
        outsideRepository.push(portable)
        continue
      }
    }
    pathspecs.push(portable)
  }
  return { pathspecs, absolute, outsideRepository }
}

/** Turn a git failure into the plugin's coded-error shape. */
function gitFailure(error: unknown): EngineeringContextError {
  if (error instanceof GitError) {
    const code = error.code === -1 ? 'git_not_found' : 'git_failed'
    return new EngineeringContextError(code, error.message, { exitCode: error.code, stderr: error.stderr.trim() })
  }
  throw error
}

async function currentAction(scope: ResolvedScope, dependencies: ToolDependencies): Promise<ReturnType<typeof okOutcome>> {
  const gitPath = dependencies.config.gitPath
  const root = scope.workspace.path
  const repository = await repositoryState(gitPath, root, undefined, isInside)
  const [branch, head] = repository.isRepository
    ? await Promise.all([currentBranch(gitPath, root, undefined), headCommit(gitPath, root, undefined)])
    : [null, null]
  const paths = versionedPaths(scope, repository.root)
  let dirty: string[] = []
  if (repository.isRepository) {
    try {
      dirty = await changedPaths(gitPath, root, paths.pathspecs, undefined)
    } catch (error) {
      throw gitFailure(error)
    }
  }

  const warnings = [...scope.view.warnings]
  if (!repository.isRepository) {
    warnings.push(
      `This workspace is not inside a git repository, so nothing is versioned yet. Create one yourself (for example "git init" at ${root}) — this plugin never initializes a repository.`,
    )
  } else if (!repository.insideWorkspace) {
    warnings.push(
      `The repository root ${repository.root} is OUTSIDE the workspace, so commits made here share history with unrelated content.`,
    )
  }
  for (const path of paths.outsideRepository) {
    warnings.push(`${path} is not covered by the repository at ${repository.root ?? '?'}, so it cannot be versioned.`)
  }

  const details = [
    `Repository: ${repository.isRepository ? (repository.root ?? '?') : 'none'}`,
    `Branch: ${branch ?? '—'}${head === null ? ' (no commit yet)' : ''}`,
    `HEAD: ${head ?? 'none'}`,
    `Versioned paths: ${paths.pathspecs.join(', ') || 'none'}`,
    `Uncommitted changes in them: ${dirty.length}`,
    ...cappedList(dirty, (line) => `  ${line}`, 10),
    'Next: eng_version action=diff to see what changed, or action=commit to put it into history.',
  ]

  return okOutcome(
    'eng_version',
    scope.view,
    repository.isRepository
      ? `At ${head === null ? 'an unborn branch' : `commit ${head.slice(0, 8)}`}${branch === null ? '' : ` on ${branch}`}; ${dirty.length} uncommitted change(s) in the versioned paths.`
      : 'This workspace is not inside a git repository, so there is no version information.',
    {
      repository: { isRepository: repository.isRepository, root: repository.root, insideWorkspace: repository.insideWorkspace },
      branch,
      head,
      versionedPaths: paths.pathspecs,
      outsideRepository: paths.outsideRepository,
      // Bounded on purpose: a first export of a real project is over a thousand
      // untracked files, and the count is what a caller acts on.
      uncommittedCount: dirty.length,
      uncommitted: dirty.slice(0, MAX_LISTED),
    },
    { details, warnings, dryRun: true },
  )
}

async function commitAction(
  scope: ResolvedScope,
  args: VersionArgs,
  dependencies: ToolDependencies,
): Promise<ReturnType<typeof okOutcome>> {
  const gitPath = dependencies.config.gitPath
  const root = scope.workspace.path
  const repository = await repositoryState(gitPath, root, undefined, isInside)
  if (!repository.isRepository) {
    throw new EngineeringContextError(
      'repository_not_found',
      `This workspace is not inside a git repository, so there is nothing to commit into. Create one yourself (for example "git init" at ${root}); this plugin never initializes a repository.`,
      { workspace: root },
    )
  }

  const paths = versionedPaths(scope, repository.root)
  if (paths.pathspecs.length === 0) {
    throw new EngineeringContextError(
      'invalid_argument',
      'No versioned path of this project is covered by the repository, so there is nothing to commit.',
      { repository: repository.root, outsideRepository: paths.outsideRepository },
    )
  }

  const dirty = await changedPaths(gitPath, root, paths.pathspecs, undefined)
  const message = args.message?.trim()
  const dryRun = args.dry_run !== false

  const warnings = [...scope.view.warnings]
  if (!repository.insideWorkspace) {
    warnings.push(
      `The repository root ${repository.root} is OUTSIDE the workspace; this commit shares history with unrelated content.`,
    )
  }
  for (const path of paths.outsideRepository) {
    warnings.push(`${path} is not covered by the repository and will not be committed.`)
  }

  if (dryRun) {
    return okOutcome(
      'eng_version',
      scope.view,
      dirty.length === 0
        ? 'Dry run: there is nothing to commit in the versioned paths.'
        : `Dry run: would commit ${dirty.length} change(s) from ${paths.pathspecs.join(', ')}. Pass dry_run=false to commit.`,
      { repository: repository.root, pathspecs: paths.pathspecs, wouldCommit: dirty, message: message ?? null },
      {
        details: [
          `Would stage and commit: ${paths.pathspecs.join(', ')}`,
          ...cappedList(dirty, (line) => `  ${line}`, 20),
          message === undefined
            ? 'A message is required to commit for real: pass message=...'
            : `Message: ${message}`,
          'Note: `.ap17` files are excluded by .gitignore and are never committed.',
        ],
        warnings,
        dryRun: true,
      },
    )
  }

  if (message === undefined) {
    throw new EngineeringContextError('invalid_argument', 'action=commit needs a non-empty message when dry_run=false.', {})
  }

  let result: { hash: string | null; changed: string[] }
  try {
    result = await commitPaths(gitPath, root, paths.pathspecs, message, undefined)
  } catch (error) {
    throw gitFailure(error)
  }

  return okOutcome(
    'eng_version',
    scope.view,
    result.hash === null
      ? 'Nothing to commit: the versioned paths hold no change.'
      : `Committed ${result.hash.slice(0, 8)} with ${result.changed.length} change(s).`,
    { repository: repository.root, hash: result.hash, committed: result.changed, message },
    {
      details: [
        result.hash === null ? 'No change in the versioned paths.' : `Commit: ${result.hash}`,
        ...cappedList(result.changed, (line) => `  ${line}`, 20),
        'The commit is local; this plugin never pushes.',
      ],
      warnings,
      dryRun: false,
    },
  )
}

async function logAction(
  scope: ResolvedScope,
  args: VersionArgs,
  dependencies: ToolDependencies,
): Promise<ReturnType<typeof okOutcome>> {
  const gitPath = dependencies.config.gitPath
  const root = scope.workspace.path
  const repository = await repositoryState(gitPath, root, undefined, isInside)
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
  const paths = versionedPaths(scope, repository.root)

  let commits: GitCommit[] = []
  if (repository.isRepository) {
    try {
      commits = await readLog(gitPath, root, paths.pathspecs, limit, undefined)
    } catch (error) {
      throw gitFailure(error)
    }
  }

  return okOutcome(
    'eng_version',
    scope.view,
    repository.isRepository
      ? `${commits.length} commit(s) touched ${paths.pathspecs.join(', ')} (newest first).`
      : 'No repository, so there is no history.',
    { repository: repository.root, pathspecs: paths.pathspecs, commits },
    {
      details: [
        `Paths: ${paths.pathspecs.join(', ') || 'none'}`,
        ...cappedList(commits, (commit) => `  ${commit.hash.slice(0, 8)}  ${commit.date}  ${commit.subject}`),
        commits.length === 0 ? 'No commit touched these paths yet.' : 'Use action=diff to see what changed between two of them.',
      ],
      warnings: scope.view.warnings,
      dryRun: true,
    },
  )
}

async function diffAction(
  scope: ResolvedScope,
  args: VersionArgs,
  dependencies: ToolDependencies,
): Promise<ReturnType<typeof okOutcome>> {
  const gitPath = dependencies.config.gitPath
  const root = scope.workspace.path
  const repository = await repositoryState(gitPath, root, undefined, isInside)
  if (!repository.isRepository) {
    throw new EngineeringContextError('repository_not_found', 'This workspace is not inside a git repository.', {
      workspace: root,
    })
  }

  const paths = versionedPaths(scope, repository.root)
  const to = args.to?.trim() ?? 'HEAD'
  const from = args.from?.trim() ?? `${to}^`

  let diff: Awaited<ReturnType<typeof diffNameStatus>>
  try {
    diff = await diffNameStatus(gitPath, root, from, to, paths.pathspecs, undefined)
  } catch (error) {
    throw gitFailure(error)
  }

  const byStatus: Record<string, number> = {}
  for (const file of diff.files) byStatus[file.status] = (byStatus[file.status] ?? 0) + 1

  const warnings = [...scope.view.warnings]
  const details = [
    `Range: ${from}..${to}`,
    `Paths: ${paths.pathspecs.join(', ') || 'none'}`,
    `${diff.files.length} file(s) changed: ${Object.entries(byStatus).map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`,
    ...cappedList(diff.files, (file) => `  ${file.status} ${file.path}`, 20),
  ]

  let artifact: string | null = null
  if (args.full === true) {
    let patch: string
    try {
      patch = await diffPatch(gitPath, root, from, to, paths.pathspecs, undefined)
    } catch (error) {
      throw gitFailure(error)
    }
    const project = requireProject(scope)
    const safe = `${from}..${to}`.replace(/[^A-Za-z0-9._-]+/gu, '_')
    artifact = `${projectStateDir(scope.config, project.id)}/diffs/${safe}.patch`
    const absolute = fromPortable(root, artifact)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, patch, 'utf8')
    details.push(`Full patch (${patch.length} bytes) written to ${artifact}`)
  } else if (diff.files.length > 0) {
    details.push('Pass full=true to write the complete patch as an artifact instead of reading it here.')
  }

  if (diff.files.length === 0) {
    warnings.push(
      'No file changed in the versioned paths for this range. That is not the same as "the engineering did not change": export the project first, then compare.',
    )
  }

  return okOutcome(
    'eng_version',
    scope.view,
    `${diff.files.length} file(s) differ between ${from} and ${to} in the versioned paths.`,
    { range: { from, to }, pathspecs: paths.pathspecs, files: diff.files, byStatus, stat: diff.summary, artifact },
    { details, warnings, dryRun: true },
  )
}

/**
 * Build the `eng_version` tool.
 * @param dependencies - the plugin dependencies.
 */
export function versionTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: 'eng_version',
    description:
      'Version the engineering export tree of the selected project: report which revision this workspace is at and ' +
      'what is uncommitted, commit the export tree plus this project state, list the commits that touched them, and ' +
      'diff two revisions. Only the project export directory and the plugin state directory are versioned — never the ' +
      '.ap17, which is binary and would only report "changed". It runs git itself with fixed arguments, so it never ' +
      'exposes raw git and cannot be pointed at the wrong repository; it never initializes a repository, never forces, ' +
      'never rewrites history and never pushes, and action=commit is dry-run by default.',
    parameters: VERSION_PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        switch (args.action) {
          case 'current':
            return await currentAction(scope, dependencies)
          case 'commit':
            return await commitAction(scope, args, dependencies)
          case 'log':
            return await logAction(scope, args, dependencies)
          case 'diff':
            return await diffAction(scope, args, dependencies)
          default: {
            const unknown: never = args.action
            throw new EngineeringContextError('invalid_argument', `Unknown action: ${String(unknown)}`, {
              supported: ['current', 'commit', 'log', 'diff'],
            })
          }
        }
      } catch (error) {
        return failedOutcome('eng_version', scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}

