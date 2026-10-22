/**
 * dsh-tool-git host entry — the capability layer.
 *
 * This row registers **no model-facing tools**. It provides:
 *
 * - the `gitContext` cordis service, which resolves git repositories from an
 *   explicit root and runs `git` against them. Sibling plugins consume it via
 *   `ctx.get('gitContext')` without importing this package; and
 * - the `tools/pre-execute` safety gate, which denies (or asks about)
 *   destructive git operations such as force push, hard reset, and history
 *   rewrites — whether they arrive through the `/tools` row's own tools or
 *   through a shell tool.
 *
 * The twelve `git_*` model tools live on the `dsh-tool-git/tools` subpath
 * (`./tools-entry.ts`), so a profile/preset can grant them to one agent
 * without also handing them to every other agent. That row injects
 * `gitContext`; without this host row it does not load at all, so a missing
 * host row fails closed instead of producing unguarded tools.
 *
 * @module dsh-tool-git
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSafetyGate, type DestructivePolicy } from './safety.ts'
import { createGitContextService } from './service.ts'

export const name = 'tool-git'
export const inject = ['tools']

/** dsh-tool-git host configuration (service + safety gate). */
export interface Config {
  /** The `git` executable to invoke. Defaults to `git` on PATH. */
  gitPath: string
  /**
   * How the safety gate treats destructive git operations: `deny` (default)
   * rejects them with an explanation, `ask` routes them through the approval
   * seam, `allow` disables the gate.
   */
  destructivePolicy: DestructivePolicy
  /** Extra case-insensitive regex strings matched against shell command text. */
  extraDestructivePatterns: string[]
  /** Default commit count for `git_log` when the caller omits `maxCount`. */
  logMaxCommits: number
  /** Default unified-diff context lines for `git_diff` / `git_show` patches. */
  diffContextLines: number
}

/**
 * There is deliberately no `workDir` here. Repository roots are resolved from
 * the calling session's `exec.agent.session.header.cwd` (or from the explicit
 * root passed to the `gitContext` service); a process-cwd-derived default was
 * the trap that made tools operate on whichever directory happened to spawn
 * the host.
 */
export const Config: z<Config> = z.object({
  gitPath: z.string().default('git'),
  destructivePolicy: z.union([
    z.const('deny'),
    z.const('ask'),
    z.const('allow'),
  ]).default('deny'),
  extraDestructivePatterns: z.array(z.string()).default([]),
  logMaxCommits: z.number().default(20),
  diffContextLines: z.number().default(3),
})

/**
 * Apply the host entry: provide the `gitContext` service and install the
 * destructive-command safety gate. Model-facing tools are registered by the
 * `dsh-tool-git/tools` entry instead.
 * @param ctx - registrant context carrying the tool runtime.
 * @param config - validated host configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('gitContext', createGitContextService({
    gitPath: config.gitPath,
    logMaxCommits: config.logMaxCommits,
    diffContextLines: config.diffContextLines,
  }))
  installSafetyGate(ctx, {
    destructivePolicy: config.destructivePolicy,
    extraDestructivePatterns: config.extraDestructivePatterns,
  })
}
