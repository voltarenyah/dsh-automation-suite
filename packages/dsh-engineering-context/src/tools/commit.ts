/**
 * `project_commit` — record a synced change set in git, with a message that says why.
 *
 * The second half of the two-step version workflow: `project_sync` writes the
 * source tree and leaves it dirty, `project_diff` says what changed, and this tool
 * commits exactly the device directory. Two things are deliberate:
 *
 * - **The message is the caller's.** The plugin cannot know why a block changed;
 *   it only knows the facts it appends as trailers (checksum, state id). An empty
 *   message is refused rather than replaced by a generated one, because a history
 *   of generated subjects is what this tool exists to end.
 * - **It plans by default.** `dry_run` shows the paths, the ledger it would
 *   reference and the exact message (trailers included) before anything is
 *   recorded, so the caller can put that in front of the user first.
 *
 * @module dsh-engineering-context/tools/commit
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { engineeringAccess, type EngineeringAccessLike } from '../access.js'
import { planCommit, runCommit } from '../commit.js'
import type { DeviceInfo } from '../device.js'
import { resolveDevice } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { defineOutcomeTool, failedOutcome, okOutcome } from './outcome.js'

/** The tool name, used by the registrar and the tests. */
export const PROJECT_COMMIT_TOOL = 'project_commit'

const PARAMETERS = {
  message: {
    type: 'string',
    required: true,
    description:
      'The commit message: a subject line saying what changed and why, in the user\'s language, plus an optional body. Required — the ' +
      'tool refuses an empty message instead of inventing one. The plugin appends the `Tia-Op` / `Tia-Checksum` / `Tia-State` trailer ' +
      'block, so do not hand-write those lines; if you pass a message that already carries them (for example the one project_sync ' +
      'suggested) they are kept as they are.',
  },
  dry_run: {
    type: 'boolean',
    description:
      'Default true: report the paths that would be committed, the evidence ledger and the exact message, writing nothing. Pass false ' +
      'only after the user has seen that plan and agreed to it.',
  },
  device: {
    type: 'string',
    description:
      'Optional device name. Required only when the workspace holds more than one device directory under source/; the tool never ' +
      'guesses which PLC to commit.',
  },
} as const

/**
 * Build the `project_commit` tool.
 *
 * @param dependencies - the plugin dependencies.
 * @returns a registry-ready definition.
 */
export function commitTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: PROJECT_COMMIT_TOOL,
    description:
      'Commit the engineering source tree that project_sync just updated, with a message that says why the change exists. It commits ' +
      'exactly the device directory (never unrelated staged files), refuses an empty message, and refuses to run when there is no ' +
      'evidence ledger to describe (sync first). Returns the paths, the ledger facts, the final message and the commit hash. Defaults to ' +
      'a plan: pass dry_run=false to create the commit — do that only after the user has seen the plan.',
    parameters: PARAMETERS,
    async execute(args, exec) {
      let scope: ResolvedScope | null = null
      let device: DeviceInfo | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const service: EngineeringAccessLike | undefined = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA cannot be described. Install the TIA interface plugin.',
            { service: 'engineeringAccess' },
          )
        }
        device = await resolveDevice(scope, service, exec)
        const message = typeof args.message === 'string' ? args.message : ''

        if (args.dry_run !== false) {
          const plan = await planCommit(scope, device, message)
          const nothing = plan.paths.length === 0
          return okOutcome(
            PROJECT_COMMIT_TOOL,
            scope.view,
            nothing
              ? 'Dry run: nothing to commit — the device directory has no uncommitted change.'
              : `Dry run: would commit ${plan.paths.length} path(s) under ${plan.relative}.`,
            {
              device: plan.device,
              paths: plan.paths,
              relative: plan.relative,
              evidence: plan.evidence,
              message: plan.message,
              wouldCommit: !nothing,
            },
            {
              dryRun: true,
              details: [
                `PLC: ${plan.device.device} / ${plan.device.software} → ${plan.device.directory}`,
                nothing
                  ? 'Paths: none (the device directory matches HEAD).'
                  : `Paths: ${plan.paths.length} — ${plan.paths.slice(0, 10).join(', ')}${plan.paths.length > 10 ? ', …' : ''}`,
                `Evidence: ${plan.evidence.objects} object(s), state ${plan.evidence.stateId ?? 'unknown'}, checksum ${plan.evidence.plcChecksum ?? 'unknown'}.`,
                '',
                'Message that would be recorded:',
                ...plan.message.split(/\r?\n/u).map((line) => `  ${line}`),
              ],
            },
          )
        }

        const result = await runCommit(scope, device, message, exec)
        return okOutcome(
          PROJECT_COMMIT_TOOL,
          scope.view,
          result.commit.committed
            ? `Committed ${result.commit.hash ?? '(unknown)'}: ${result.paths.length} path(s) under ${result.relative}.`
            : 'Nothing to commit: the device directory already matched HEAD.',
          {
            device: result.device,
            paths: result.paths,
            relative: result.relative,
            evidence: result.evidence,
            message: result.message,
            committed: result.commit.committed,
            hash: result.commit.hash,
          },
          {
            dryRun: false,
            details: [
              `PLC: ${result.device.device} / ${result.device.software} → ${result.device.directory}`,
              result.commit.committed
                ? `Commit: ${result.commit.hash ?? 'unknown'} (${result.paths.length} path(s)).`
                : 'Commit: nothing to commit.',
              `Evidence: ${result.evidence.objects} object(s), state ${result.evidence.stateId ?? 'unknown'}.`,
            ],
          },
        )
      } catch (error) {
        return failedOutcome(PROJECT_COMMIT_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
