/**
 * Shared per-call context for the git tools: resolve the calling session's
 * working directory, bind the host-provided `gitContext` service to it, and
 * run `git` with the call's cancellation signal.
 *
 * The repository root is **never** `process.cwd()` and never a model-supplied
 * path: it is the session cwd recorded on the tool call's agent.
 * @module dsh-tool-git/tools/context
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GitContextService } from '../service.ts'

/** Deployment options every tool inherits from the host row via the service. */
export interface ToolOptions {
  /** The host-provided git capability. */
  service: GitContextService
  /** Default commit count for `git_log` when the caller omits `maxCount`. */
  logMaxCommits: number
  /** Default unified-diff context lines for `git_diff` / `git_show` patches. */
  diffContextLines: number
}

/**
 * Read the calling session's working directory from the execution context.
 *
 * There is no fallback to `process.cwd()` and no model-supplied replacement:
 * a call without a session cwd is an error, because silently picking a
 * directory is exactly the trap this plugin is removing.
 * @param exec - the tool execution context.
 * @returns the absolute session cwd.
 * @throws when the call carries no session cwd.
 */
export function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error(
      'dsh-tool-git: no session working directory (exec.agent.session.header.cwd); '
      + 'refusing to fall back to process.cwd()',
    )
  }
  return cwd
}

/**
 * Bind one call to the repository containing its session cwd.
 * @param opts - deployment options (host service + tool defaults).
 * @param exec - the tool execution context (carries the session cwd and signal).
 * @returns the repository root and a checked `git` runner bound to the call.
 */
export async function createGitContext(
  opts: ToolOptions,
  exec: ToolRunContext,
): Promise<{
  repoDir: string
  /** Run `git` in the repo root and require a zero exit code. */
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>
}> {
  const git = await opts.service.create(sessionCwd(exec))
  return {
    repoDir: git.repoDir,
    run: args => git.runChecked(args, { signal: exec.signal }),
  }
}
