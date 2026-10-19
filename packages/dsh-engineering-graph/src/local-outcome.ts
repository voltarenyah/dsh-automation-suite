/**
 * The envelope shared by every tool of this plugin that answers a question
 * without being an engine operation of its own.
 *
 * `knowledge_workspace` and the four drill-down tools (`knowledge_search`,
 * `knowledge_block`, `knowledge_network`, `knowledge_variable_usage`) compose
 * their answers here: they read files or issue `Query` calls, and what the model
 * sees is a summary, bounded detail lines and a structured payload. The engine
 * envelope (`operation` / `durationMs` / `changes` / `diagnostics`) would have to
 * claim an engine operation and an engine duration that do not exist — a
 * drill-down tool may issue three `Query` calls — so they declare this shape
 * instead. It mirrors the sibling plugin's local-tool envelope
 * (`dsh-engineering-context`'s `tools/outcome.ts`): `ok` / `tool` / `summary` /
 * `details` / `data` / `warnings` / `error`.
 *
 * Why it matters beyond tidiness: the framework delivers only what `render`
 * returns, never `data` (docs/decisions.md D23's notes; `tool-surface.md` §4.4),
 * so every fact the model must act on is rendered as text, and the renderer caps
 * both the number of detail lines and the length of each one. A payload that is
 * only reachable in `data` is a payload the model does not have.
 *
 * @module dsh-engineering-graph/local-outcome
 */

import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Lists and detail lines are capped at this many entries, with the remainder counted. */
export const MAX_DETAIL_LINES = 40

/** Warnings rendered in full before the remainder is only counted. */
export const MAX_WARNINGS = 10

/** One local tool result, before it is converted to the wire envelope. */
export interface LocalOutcome {
  ok: boolean
  /** The tool that produced the outcome. */
  tool: string
  summary: string
  details: string[]
  data: JsonValue
  warnings: string[]
  error: { code: string; message: string; remediation: string | null } | null
}

/**
 * The declared output schema of a local tool.
 *
 * `as const` is what `defineTool` needs: the author-facing spec is a literal, and
 * widening `type: 'object'` to `string` would stop it compiling against
 * `ValueSchemaSpec` (the same reason the engine envelope is declared `as const`).
 *
 * @param description - what this tool answers, for the model reading the schema.
 */
export function localOutcomeSchema(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    description,
    properties: {
      ok: { type: 'boolean', required: true, description: 'True when the call answered.' },
      tool: { type: 'string', required: true, description: 'The tool that produced this outcome.' },
      summary: { type: 'string', required: true, description: 'One-line result.' },
      details: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Bounded, human-readable lines (at most ${MAX_DETAIL_LINES}).`,
      },
      data: { type: 'json', description: 'The structured payload, for a caller that can read it.' },
      warnings: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Conditions worth knowing even though the call answered (truncation, a stale index, skipped rows).',
      },
      error: { type: 'json', description: 'Structured failure: code, message and remediation.' },
    },
  } as const
}

/** Renders the outcome: header, bounded details, warnings, failure. */
export function renderLocalOutcome(outcome: LocalOutcome): string {
  const lines = [`${outcome.tool}: ${outcome.summary}`]
  lines.push(...outcome.details.slice(0, MAX_DETAIL_LINES))
  if (outcome.details.length > MAX_DETAIL_LINES) {
    lines.push(`… ${outcome.details.length - MAX_DETAIL_LINES} more detail line(s) in data`)
  }
  if (outcome.warnings.length > 0) {
    lines.push(`Warnings (${outcome.warnings.length}):`)
    for (const warning of outcome.warnings.slice(0, MAX_WARNINGS)) lines.push(`  - ${warning}`)
    if (outcome.warnings.length > MAX_WARNINGS) {
      lines.push(`  … ${outcome.warnings.length - MAX_WARNINGS} more warning(s) in data`)
    }
  }
  if (outcome.error !== null) {
    lines.push(`Error code: ${outcome.error.code}`, `Reason: ${outcome.error.message}`)
    if (outcome.error.remediation !== null) lines.push(`Remediation: ${outcome.error.remediation}`)
  }
  return lines.join('\n')
}

/** Builds a successful outcome. */
export function localSuccess(
  tool: string,
  summary: string,
  details: string[],
  data: unknown,
  warnings: string[] = [],
): LocalOutcome {
  return {
    ok: true,
    tool,
    summary,
    details,
    data: data as JsonValue,
    warnings,
    error: null,
  }
}

/** Builds a failure outcome. */
export function localFailure(tool: string, code: string, message: string, remediation: string | null): LocalOutcome {
  return {
    ok: false,
    tool,
    summary: message,
    details: [],
    data: null,
    warnings: [],
    error: { code, message, remediation },
  }
}

/** Bridges an outcome into the lossless-JSON object the registry validates. */
export function asWireOutcome(outcome: LocalOutcome): {
  ok: boolean
  tool: string
  summary: string
  details: string[]
  data: JsonValue
  warnings: string[]
  error: JsonValue
} {
  return {
    ok: outcome.ok,
    tool: outcome.tool,
    summary: outcome.summary,
    details: [...outcome.details],
    data: outcome.data,
    warnings: [...outcome.warnings],
    error: outcome.error as unknown as JsonValue,
  }
}
