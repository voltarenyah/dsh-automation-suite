/**
 * The shared tool envelope.
 *
 * Every tool of this plugin answers with the same shape: what it did, the scope
 * it did it in, a bounded set of human-readable `details`, the structured
 * payload, and any failure **as data** (`ok: false` plus a coded `error`) rather
 * than as an exception — the model acts on the code and the details, and an
 * exception would reach it only as a generic tool failure.
 *
 * The text the model sees is deliberately bounded: a summary, a handful of
 * detail lines and a drilldown pointer, never the payload. The framework prunes
 * oversized results by cutting the **middle** out of them (Pruner
 * `thresholdChars: 8192`) and spills anything above `maxInlineTokens: 12500`, so
 * a self-authored summary plus a path is always better than being truncated
 * (docs/ARCHITECTURE.md §6).
 *
 * @module dsh-engineering-context/tools/outcome
 */

import {
  defineTool,
  type InferArgs,
  type JsonValue,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import { describeFailure } from '../errors.js'
import type { ScopeView } from '../scope.js'

/** Lists are capped at this many entries, with the remainder reported as a count. */
export const MAX_LISTED = 20

/** The maximum number of detail lines rendered into the model-facing text. */
export const MAX_DETAIL_LINES = 40

/** One tool result, before it is converted to the wire envelope. */
export interface EngineeringOutcome {
  /** True when the call succeeded. */
  ok: boolean
  /** The tool that produced this outcome. */
  tool: string
  /** True when nothing was written. */
  dryRun: boolean
  /** One line the model reads first. */
  summary: string
  /** Bounded, human-readable specifics (counts, paths, next steps). */
  details: string[]
  /** The scope this call ran in, or null when it could not be established. */
  scope: ScopeView | null
  /** The structured payload. */
  data: unknown
  /** Things that are true but were not asked for — always worth the model's attention. */
  warnings: string[]
  /** The failure, or null. */
  error: { code: string; message: string; details?: unknown } | null
}

/** The declared output schema, shared by every tool. */
export const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Outcome of one engineering-context call: the scope it ran in, its payload, and any failure as data.',
  properties: {
    ok: { type: 'boolean', required: true, description: 'True when the call succeeded.' },
    tool: { type: 'string', required: true, description: 'The tool that produced this outcome.' },
    dryRun: { type: 'boolean', required: true, description: 'True when nothing was written.' },
    summary: { type: 'string', required: true, description: 'One-line result.' },
    details: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Bounded human-readable specifics.',
    },
    scope: { type: 'json', description: 'The workspace/project/branch/version this call ran in.' },
    data: { type: 'json', description: 'Structured payload for this action.' },
    warnings: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Conditions the caller should know about even though the call succeeded.',
    },
    error: { type: 'json', description: 'Structured failure: code, message and details.' },
  },
} as const

/**
 * Convert an arbitrary value into lossless JSON.
 *
 * The registry rejects a tool result that is not losslessly JSON-serializable, so
 * this runs once at the boundary: `undefined` members are dropped, non-finite
 * numbers become `null`, and everything else passes through.
 *
 * @param value - any value.
 * @returns the JSON projection.
 */
export function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((entry) => toJson(entry))
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      result[key] = toJson(entry)
    }
    return result
  }
  return null
}

/**
 * Build a successful outcome.
 *
 * @param tool - the tool name.
 * @param scope - the resolved scope.
 * @param summary - the one-line result.
 * @param data - the structured payload.
 * @param options - extra detail lines and warnings.
 */
export function okOutcome(
  tool: string,
  scope: ScopeView,
  summary: string,
  data: unknown,
  options: { details?: string[]; warnings?: string[]; dryRun?: boolean } = {},
): EngineeringOutcome {
  return {
    ok: true,
    tool,
    dryRun: options.dryRun === true,
    summary,
    details: options.details ?? [],
    scope,
    data,
    warnings: options.warnings ?? [],
    error: null,
  }
}

/**
 * Build a failed outcome from anything thrown, keeping whatever scope was
 * resolvable.
 *
 * @param tool - the tool name.
 * @param scope - the resolved scope, or null when resolution itself failed.
 * @param error - whatever was thrown.
 * @param warnings - warnings gathered before the failure.
 */
export function failedOutcome(
  tool: string,
  scope: ScopeView | null,
  error: unknown,
  warnings: string[] = [],
): EngineeringOutcome {
  const failure = describeFailure(error)
  return {
    ok: false,
    tool,
    dryRun: true,
    summary: `${failure.code}: ${failure.message}`,
    details: [],
    scope,
    data: null,
    warnings,
    error: { code: failure.code, message: failure.message, details: toJson(failure.details) },
  }
}

function asJsonOutcome(outcome: EngineeringOutcome): {
  ok: boolean
  tool: string
  dryRun: boolean
  summary: string
  details: string[]
  scope: JsonValue
  data: JsonValue
  warnings: string[]
  error: JsonValue
} {
  return {
    ok: outcome.ok,
    tool: outcome.tool,
    dryRun: outcome.dryRun,
    summary: outcome.summary,
    details: [...outcome.details],
    scope: toJson(outcome.scope),
    data: toJson(outcome.data),
    warnings: [...outcome.warnings],
    error: toJson(outcome.error),
  }
}

/**
 * Render the model-facing text: newest facts first, bounded, no payload.
 *
 * @param outcome - the outcome to render.
 * @returns the text block content.
 */
export function renderOutcome(outcome: EngineeringOutcome): string {
  const lines: string[] = [`${outcome.tool}: ${outcome.summary}`]
  lines.push(...outcome.details.slice(0, MAX_DETAIL_LINES))
  if (outcome.details.length > MAX_DETAIL_LINES) {
    lines.push(`… ${outcome.details.length - MAX_DETAIL_LINES} more detail line(s) omitted`)
  }

  const scope = outcome.scope
  if (scope === null) {
    lines.push('Scope: not established.')
  } else {
    const workspace = scope.workspace.registered
      ? `${scope.workspace.path} (registered workspace${scope.workspace.title === null ? '' : `: ${scope.workspace.title}`})`
      : `${scope.workspace.path} (NOT a registered workspace)`
    const project = scope.project === null ? 'none' : `${scope.project.id} (${scope.project.title})`
    lines.push(
      `Scope: workspace ${workspace}; project ${project}; branch ${scope.branch ?? '—'}; version ${scope.version.kind === 'none' ? 'none' : scope.version.id}`,
    )
  }

  if (outcome.warnings.length > 0) {
    lines.push(`Warnings (${outcome.warnings.length}):`)
    for (const warning of outcome.warnings.slice(0, MAX_LISTED)) lines.push(`  - ${warning}`)
  }
  if (outcome.error !== null) {
    lines.push(`Error: ${outcome.error.code} — ${outcome.error.message}`)
    const details = outcome.error.details
    if (details !== null && details !== undefined && typeof details === 'object' && !Array.isArray(details)) {
      for (const [key, entry] of Object.entries(details as Record<string, unknown>)) {
        lines.push(`  ${key}: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Build one tool over the shared envelope.
 *
 * The single `as unknown as EngineeringOutcome` cast lives here: the runtime
 * shape is guaranteed by {@link asJsonOutcome}, which is what the registry
 * actually validates, while the render signature is driven by the tool's output
 * schema inference.
 *
 * @param options - the tool name, description, parameters and body.
 * @returns a registry-ready definition.
 */
export function defineOutcomeTool<const S extends ParameterSchemaSpec>(options: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<EngineeringOutcome>
}): ToolDefinition {
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value as unknown as EngineeringOutcome) }],
    },
    execute: async (args, exec) => asJsonOutcome(await options.execute(args, exec)),
  })
}

/**
 * Render a capped list, reporting the remainder as a count rather than dropping
 * it silently.
 *
 * @param items - the entries to render.
 * @param line - one entry to one line.
 * @param max - the cap; defaults to {@link MAX_LISTED}.
 * @returns the lines, plus a remainder line when capped.
 */
export function cappedList<T>(items: readonly T[], line: (item: T) => string, max = MAX_LISTED): string[] {
  const lines = items.slice(0, max).map((item) => line(item))
  if (items.length > max) lines.push(`… ${items.length - max} more`)
  return lines
}

/** A short, single-line rendering of a scope for embedding in a summary. */
export function scopeLabel(scope: ScopeView): string {
  const project = scope.project === null ? 'no project' : scope.project.id
  const version = scope.version.kind === 'none' ? 'no version control yet' : `version ${scope.version.id}`
  return `workspace ${scope.workspace.path} / ${project} / ${version}`
}
