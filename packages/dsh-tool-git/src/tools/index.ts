/**
 * Registry of the structured git tools, bound to the host-provided
 * `gitContext` service.
 * @module dsh-tool-git/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GitContextService } from '../service.ts'
import { defineBranchTool } from './branch.ts'
import { defineCheckoutTool } from './checkout.ts'
import { defineCommitTool } from './commit.ts'
import { defineDiffTool } from './diff.ts'
import { defineFetchTool } from './fetch.ts'
import { defineLogTool } from './log.ts'
import { definePullTool } from './pull.ts'
import { defineRemoteTool } from './remote.ts'
import { defineShowTool } from './show.ts'
import { defineStageTool } from './stage.ts'
import { defineStashTool } from './stash.ts'
import { defineStatusTool } from './status.ts'
import type { ToolOptions } from './context.ts'

/** Register every git tool on the context's tool registry. */
export function registerGitTools(ctx: Context, service: GitContextService): void {
  const options: ToolOptions = {
    service,
    logMaxCommits: service.defaults.logMaxCommits,
    diffContextLines: service.defaults.diffContextLines,
  }
  const definitions = [
    defineStatusTool(options),
    defineDiffTool(options),
    defineLogTool(options),
    defineBranchTool(options),
    defineStageTool(options),
    defineCommitTool(options),
    defineStashTool(options),
    defineShowTool(options),
    defineFetchTool(options),
    definePullTool(options),
    defineRemoteTool(options),
    defineCheckoutTool(options),
  ]
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }
}
