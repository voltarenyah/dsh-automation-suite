/**
 * dsh-tool-git `/tools` entry — the twelve model-facing git tools.
 *
 * Split off the host row so a profile or agent preset can grant the tools to
 * one agent without handing them to every agent on the host plane. The row
 * injects both `tools` and `gitContext`:
 *
 * - `gitContext` comes from the package's host row (`dsh-tool-git`) and is how
 *   these tools bind to a repository; and
 * - requiring it makes the split fail closed. If the host row is missing, this
 *   row never starts, so the tools are not registered at all — there is no
 *   configuration in which the tools exist without the host-level safety gate.
 *
 * The tools take no repository path argument. Their root is always the calling
 * session's cwd (`exec.agent.session.header.cwd`), resolved per call.
 *
 * @module dsh-tool-git/tools-entry
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerGitTools } from './tools/index.ts'

export const name = 'tool-git-tools'
export const inject = ['tools', 'gitContext']

/**
 * Apply the tools entry: register the twelve git tools, bound to the
 * host-provided `gitContext` service.
 * @param ctx - the (preset-scoped) registrant context.
 */
export function apply(ctx: Context): void {
  const service = ctx.get('gitContext')
  if (service === undefined) {
    throw new Error(
      'dsh-tool-git/tools requires the "gitContext" service: load the dsh-tool-git host row first',
    )
  }
  registerGitTools(ctx, service)
}
