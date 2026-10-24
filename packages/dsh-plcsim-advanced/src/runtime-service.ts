/**
 * The `plcsimRuntime` seam between the host row and this package's `/tools` row.
 *
 * The host row owns the one controller process and the one Runtime Manager API
 * client; the tools row only registers model-facing tools against this narrow
 * object. It is internal to the package: other plugins will use the public
 * `simulationAccess` seam once the program-load path is settled.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type { ToolDependencies } from './tools.js'

export const PLCSIM_RUNTIME_SERVICE = 'plcsimRuntime'

export class PlcsimRuntime extends Service {
  private readonly dependencies: ToolDependencies

  readonly verbose: boolean

  readonly request: ToolDependencies['request'] = async (operation, params, options) =>
    await this.dependencies.request(operation, params, options)

  readonly status: ToolDependencies['status'] = () => this.dependencies.status()

  constructor(ctx: Context, dependencies: ToolDependencies) {
    super(ctx, PLCSIM_RUNTIME_SERVICE)
    this.dependencies = dependencies
    this.verbose = dependencies.verbose
  }
}

export function plcsimRuntimeOf(ctx: Context): PlcsimRuntime {
  const runtime = ctx.get(PLCSIM_RUNTIME_SERVICE) as PlcsimRuntime | undefined
  if (runtime === undefined) {
    throw new Error(
      `The ${PLCSIM_RUNTIME_SERVICE} service is not in this composition: the /tools row needs the host row ` +
        `('@voltarenyah/dsh-plcsim-advanced') to be declared too.`,
    )
  }
  return runtime
}
