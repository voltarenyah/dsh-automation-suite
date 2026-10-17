/**
 * The model-facing tools of the engineering-graph plugin.
 *
 * Three tools over the engine's three operations, each returning the same
 * canonical envelope, so a model always sees `ok`, a one-line `summary`, the
 * engine's structured `data`, the (empty) `changes` / `diagnostics` lists and a
 * structured `error` carrying the engine's code, message and remediation.
 *
 * **The tool names are deliberate**: `knowledge_schema`, `knowledge_ingest`,
 * `knowledge_query`. They keep the names the origin library
 * (`Tools/KnowledgeTools.cs`, see `engine/Operations.cs`) exposed to a model, so
 * prompts, notes and muscle memory written against that surface keep working after
 * the move into DSH. The DSH house style would be an unprefixed verb_noun
 * (`ingest_exports`), which is exactly the kind of renaming that silently breaks
 * callers, so it was not done.
 *
 * Transport failures (missing executable, timeout, the process dying mid-request,
 * a protocol mismatch) are **thrown** by the client and are not caught here: the
 * framework turns them into a tool error whose text begins with the stable code,
 * and pretending they were an operation outcome would hide that the request never
 * reached the engine. Operation failures — the engine ran and refused — come back
 * as `ok: false` with the engine's own code.
 *
 * @module dsh-engineering-graph/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { LogSink } from './engine-client.js'
import type { JsonRecord, Operation, ProgressFrame, ResultFrame, ToolError, ToolOutcome } from './protocol.js'

/** Dependencies every tool body needs. */
export interface ToolDependencies {
  /**
   * Runs one engine operation. `signal` cancels the call (the engine is
   * terminated, because an engine operation cannot be interrupted), `onProgress`
   * receives the engine's progress frames while the operation runs.
   */
  request(
    operation: Operation,
    params: JsonRecord,
    options?: { signal?: AbortSignal; onProgress?: (frame: ProgressFrame) => void },
  ): Promise<ResultFrame>
  log: LogSink
}

/** The engine payload is JSON by construction; this only satisfies the type system. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

const MAX_LISTED = 20

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function strings(value: unknown): string[] {
  return list(value).map((item) => text(item) ?? '?')
}

/** The table names a `CREATE TABLE` script defines, in script order. */
function tableNames(ddl: string): string[] {
  const names: string[] = []
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/gi
  let match = pattern.exec(ddl)
  while (match !== null) {
    if (match[1] !== undefined) names.push(match[1])
    match = pattern.exec(ddl)
  }
  return names
}

// ------------------------------------------------------------------ rendering

/**
 * Renders the engine's failure. The remediation is the point of this section: the
 * engine writes it for the model to act on ("Rewrite as a SELECT", "Pass the
 * folder filled by the export step"), so it is printed, not dropped.
 */
function renderError(error: ToolError | null): string {
  if (error === null) return ''
  const lines = [`Error code: ${error.code}`, `Reason: ${error.message}`]
  const remediation = error.details === undefined ? undefined : text(error.details['remediation'])
  if (remediation !== undefined) lines.push(`Remediation: ${remediation}`)
  return lines.join('\n')
}

/**
 * Operation-specific detail lines; the full payload is always in `data`.
 *
 * `operation` is a plain string because the envelope carries the engine's own
 * spelling of it; the three the engine can return are exactly the three cases
 * below.
 */
function renderData(operation: string, data: JsonRecord | null): string {
  if (data === null) return ''
  const lines: string[] = []

  switch (operation) {
    case 'GetSchema': {
      const version = text(data['version']) ?? '?'
      if (data['unchanged'] === true) {
        lines.push(`The schema is unchanged for the known version ${version}; nothing else is returned.`)
        break
      }
      lines.push(`Schema version: ${version}`)
      const kinds = strings(data['nodeKinds'])
      lines.push(`Node kinds (${kinds.length}): ${kinds.join(', ') || 'none'}`)
      const edges = strings(data['edgeTypes'])
      lines.push(`Edge types (${edges.length}): ${edges.join(', ') || 'none'}`)
      const ddl = text(data['ddl']) ?? ''
      const tables = tableNames(ddl)
      lines.push(`Tables: ${tables.join(', ') || 'none'} (full DDL in data.ddl)`)
      const examples = list(data['exampleQueries'])
      if (examples.length > 0) {
        lines.push(`Example queries (${examples.length}):`)
        for (const item of examples.slice(0, MAX_LISTED)) {
          const entry = record(item)
          if (entry === null) continue
          const sql = text(entry['sql']) ?? ''
          lines.push(`  - ${text(entry['name']) ?? '?'}: ${sql.length > 200 ? `${sql.slice(0, 200)}…` : sql}`)
        }
      }
      lines.push(`Operations: ${strings(data['operations']).join(', ') || 'none'}`)
      break
    }
    case 'Ingest': {
      lines.push(`Database: ${text(data['dbPath']) ?? '?'}`)
      lines.push(`Source: ${text(data['source']) ?? '?'} (files found: ${numberOf(data['filesFound']) ?? 0})`)
      lines.push(
        `Imported ${numberOf(data['filesImported']) ?? 0} file(s): ` +
          `${numberOf(data['nodes']) ?? 0} node(s), ${numberOf(data['edges']) ?? 0} edge(s)`,
      )
      const byKind = record(data['byKind'])
      if (byKind !== null && Object.keys(byKind).length > 0) {
        lines.push(`By node kind: ${Object.entries(byKind).map(([kind, count]) => `${kind}=${numberOf(count) ?? 0}`).join(', ')}`)
      }
      const warnings = strings(data['warnings'])
      if (warnings.length > 0) {
        lines.push(`Warnings (${warnings.length}):`)
        for (const warning of warnings.slice(0, MAX_LISTED)) lines.push(`  - ${warning}`)
      }
      break
    }
    case 'Query': {
      lines.push(`Database: ${text(data['dbPath']) ?? '?'}`)
      lines.push(`Columns: ${strings(data['columns']).join(', ') || 'none'}`)
      const rows = list(data['rows'])
      const rowCount = numberOf(data['rowCount']) ?? rows.length
      lines.push(`Rows: ${rowCount}${data['truncated'] === true ? ' (TRUNCATED — the row cap was reached; raise max_rows, up to 1000)' : ''}`)
      for (const row of rows.slice(0, MAX_LISTED)) lines.push(`  ${JSON.stringify(row)}`)
      if (rows.length > MAX_LISTED) lines.push(`  … ${rows.length - MAX_LISTED} more row(s) in data.rows`)
      break
    }
  }

  return lines.join('\n')
}

// ----------------------------------------------------------------- the envelope

/** The value shape inferred from {@link OUTCOME_SCHEMA}. */
type OutcomeValue = InferValue<typeof OUTCOME_SCHEMA>

/** Bridges the inferred schema value back to the envelope the renderer reads. */
function renderValue(value: OutcomeValue): string {
  return renderOutcome(value as unknown as ToolOutcome)
}

/** The single place that turns an engine frame into the model-facing text. */
export function renderOutcome(outcome: ToolOutcome): string {
  const header = outcome.ok ? `${outcome.operation} succeeded.` : `${outcome.operation} FAILED.`
  const parts = [header, outcome.summary]
  const detail = renderData(outcome.operation, outcome.data)
  if (detail.length > 0) parts.push(detail)
  const error = renderError(outcome.error)
  if (error.length > 0) parts.push(error)
  if (outcome.durationMs > 0) parts.push(`(${outcome.durationMs} ms in the engine)`)
  return parts.filter((part) => part.length > 0).join('\n')
}

/** The canonical output envelope every tool declares. */
const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured outcome of one engineering-graph engine operation.',
  properties: {
    ok: { type: 'boolean', required: true, description: 'True when the operation itself succeeded.' },
    operation: { type: 'string', required: true, description: 'The engine operation that ran.' },
    dryRun: { type: 'boolean', required: true, description: 'Always false: the engine has no dry-run mode.' },
    summary: { type: 'string', required: true, description: 'One-line human readable result.' },
    data: { type: 'json', description: 'The engine payload for this operation.' },
    changes: { type: 'array', required: true, items: { type: 'json' }, description: 'What the operation changed; always empty today.' },
    diagnostics: { type: 'array', required: true, items: { type: 'json' }, description: 'Engine diagnostics; always empty today.' },
    error: { type: 'json', description: 'Structured failure: code, message and details.remediation.' },
    durationMs: { type: 'number', required: true, description: 'Time the engine spent on the operation.' },
  },
} as const

/** One human sentence describing what happened, per operation. */
function summarize(operation: Operation, frame: ResultFrame): string {
  const data = record(frame.data)
  if (!frame.ok) {
    const message = frame.error?.message ?? 'the engine reported a failure without detail'
    return `${operation} was refused: ${message}`
  }

  switch (operation) {
    case 'GetSchema': {
      const version = data === null ? undefined : text(data['version'])
      if (data !== null && data['unchanged'] === true) return `The graph schema is unchanged (version ${version ?? '?'}).`
      const kinds = data === null ? [] : strings(data['nodeKinds'])
      const edges = data === null ? [] : strings(data['edgeTypes'])
      return `The graph schema is version ${version ?? '?'} with ${kinds.length} node kind(s) and ${edges.length} edge type(s).`
    }
    case 'Ingest': {
      if (data === null) return 'The export root was ingested.'
      return (
        `Ingested ${numberOf(data['filesImported']) ?? 0} of ${numberOf(data['filesFound']) ?? 0} file(s) into ` +
        `${text(data['dbPath']) ?? 'the database'}: ${numberOf(data['nodes']) ?? 0} node(s) and ${numberOf(data['edges']) ?? 0} edge(s).`
      )
    }
    case 'Query': {
      if (data === null) return 'The query returned no payload.'
      return (
        `${numberOf(data['rowCount']) ?? 0} row(s) returned from ${text(data['dbPath']) ?? 'the database'}` +
        `${data['truncated'] === true ? ', truncated at the row cap' : ''}.`
      )
    }
  }
}

/** Turns one result frame into the canonical envelope, including the error mapping. */
export function outcomeOf(operation: Operation, frame: ResultFrame): ToolOutcome {
  const failure: ToolError | null = frame.ok
    ? null
    : {
        code: frame.error?.code ?? 'unknown_failure',
        message: frame.error?.message ?? 'The engine reported no error detail.',
        // The envelope documents `details.remediation` as the model-facing next
        // step. It is always an object so a consumer can read `details.remediation`
        // without a guard.
        details: frame.error?.remediation === undefined ? {} : { remediation: frame.error.remediation },
      }

  return {
    ok: frame.ok,
    operation,
    dryRun: false,
    summary: summarize(operation, frame),
    data: record(frame.data),
    // The engine reports neither today; the keys stay so the envelope has one
    // shape across the plugins.
    changes: [],
    diagnostics: [],
    error: failure,
    durationMs: frame.durationMs,
  }
}

async function runOperation(
  dependencies: ToolDependencies,
  operation: Operation,
  params: JsonRecord,
  exec: { signal?: AbortSignal; onProgress?: (frame: ProgressFrame) => void },
): Promise<ToolOutcome> {
  const requestOptions: { signal?: AbortSignal; onProgress?: (frame: ProgressFrame) => void } = {}
  if (exec.signal !== undefined) requestOptions.signal = exec.signal
  if (exec.onProgress !== undefined) requestOptions.onProgress = exec.onProgress
  const frame = await dependencies.request(operation, params, requestOptions)
  return outcomeOf(operation, frame)
}

/**
 * Registers every tool of this plugin on `ctx.tools`. The framework owns the
 * registrations, so their disposers are not managed here.
 *
 * @returns the registered tool names, in registration order.
 */
export function registerTools(ctx: Context, dependencies: ToolDependencies): string[] {
  const registered: string[] = []

  const register = (definition: ToolDefinition): void => {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }

  register(
    defineTool({
      name: 'knowledge_schema',
      description:
        'Return the schema of the engineering knowledge graph: the SQL DDL of its tables, the node kinds and edge ' +
        'types the graph is built from, worked example queries, and the engine operations. No database is touched, so ' +
        'it works before anything has been ingested and is the right first call whenever you need to know which ' +
        'tables and columns a knowledge_query may use. Pass known_version with a version from an earlier call to get ' +
        'a short "unchanged" answer instead of the whole payload.',
      parameters: {
        known_version: {
          type: 'string',
          description:
            'The schema version from an earlier knowledge_schema call. When it still matches, the reply is only ' +
            '{version, unchanged: true} instead of the full schema.',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.known_version === undefined ? 'Engineering graph schema' : `Engineering graph schema (${args.known_version})`,
        kind: 'read',
        rawInput: args,
      }),
      async execute(args, exec) {
        const params: JsonRecord = {}
        if (args.known_version !== undefined) params['knownVersion'] = args.known_version
        return asJsonOutcome(await runOperation(dependencies, 'GetSchema', params, { signal: exec.signal }))
      },
    }),
  )

  register(
    defineTool({
      name: 'knowledge_ingest',
      description:
        "Build (or rebuild) ONE device's knowledge database: read the export manifest in the device folder, parse " +
        'every source file it lists into a graph of nodes and edges, and write it to a SQLite database. It is a full ' +
        'rebuild, so point db_path at a database this tool owns. Call it once per device -- a project with several ' +
        'PLCs has one folder per device under source/. Progress is reported while the files are parsed and the ' +
        'database is written. Fails with DEVICE_DIR_REQUIRED, DEVICE_DIR_NOT_FOUND, NO_SOURCE_FILES or ' +
        'MANIFEST_INVALID, and with an engine error only if the database itself cannot be written.',
      parameters: {
        device_dir: {
          type: 'string',
          required: true,
          description:
            'Absolute path of the device folder to ingest, i.e. <project>/source/<device>. It holds the export ' +
            'manifest plus blocks/, types/ and tag_tables/. It must already exist; a missing folder is ' +
            'DEVICE_DIR_NOT_FOUND and one with nothing importable is NO_SOURCE_FILES.',
        },
        db_path: {
          type: 'string',
          description:
            'Absolute path of the SQLite database to write. Omit for ' +
            '<project>/knowledge/<device>/<device>_knowledge.db, where <project> holds source/ -- one folder per ' +
            'device holds everything generated for it.',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Ingest engineering exports',
        kind: 'other',
        rawInput: args,
      }),
      async execute(args, exec) {
        const params: JsonRecord = { deviceDir: args.device_dir }
        if (args.db_path !== undefined) params['dbPath'] = args.db_path
        return asJsonOutcome(
          await runOperation(dependencies, 'Ingest', params, {
            signal: exec.signal,
            // The engine reports what it is crawling and where it is writing.
            // Turning that into debug lines is what makes a slow ingest visible in
            // the plugin log without changing the tool result.
            onProgress: (frame) => dependencies.log.debug(`engine ingest [${frame.phase}] ${frame.message}`),
          }),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'knowledge_query',
      description:
        'Run one read-only SQL statement against a knowledge database built by knowledge_ingest and return the rows. ' +
        'The statement must be a single read-only SELECT, WITH or EXPLAIN — anything else (including DROP, INSERT or ' +
        'UPDATE, and more than one statement) is refused with QUERY_REJECTED, and the database is opened read-only ' +
        'as a backstop. knowledge_schema documents the tables (graph_nodes, graph_edges and the rest), their columns ' +
        'and worked example queries; call it first when you are unsure, and note that an unknown table or column ' +
        'fails with QUERY_INVALID_SQL, which names the tables that do exist. max_rows caps the returned rows ' +
        '(default 200, hard maximum 1000) and a capped result says so with truncated: true.',
      parameters: {
        db_path: {
          type: 'string',
          required: true,
          description: 'Absolute path of the SQLite database to query, i.e. the dbPath knowledge_ingest returned.',
        },
        sql: {
          type: 'string',
          required: true,
          description:
            'One read-only SELECT, WITH or EXPLAIN statement. No trailing second statement and no semicolon-separated ' +
            'list; the engine rejects both.',
        },
        max_rows: {
          type: 'integer',
          description: 'Maximum number of rows to return (default 200). The engine clamps it to the range 1..1000.',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Query engineering graph',
        kind: 'read',
        rawInput: args,
      }),
      async execute(args, exec) {
        const params: JsonRecord = { dbPath: args.db_path, sql: args.sql }
        if (args.max_rows !== undefined) params['maxRows'] = args.max_rows
        return asJsonOutcome(await runOperation(dependencies, 'Query', params, { signal: exec.signal }))
      },
    }),
  )

  return registered
}

/**
 * The registry validates the canonical value against the declared schema and
 * rejects anything that is not lossless JSON, so the envelope is converted once
 * here instead of at every return site.
 */
function asJsonOutcome(outcome: ToolOutcome): {
  ok: boolean
  operation: string
  dryRun: boolean
  summary: string
  data: JsonValue
  changes: JsonValue[]
  diagnostics: JsonValue[]
  error: JsonValue
  durationMs: number
} {
  return {
    ok: outcome.ok,
    operation: outcome.operation,
    dryRun: outcome.dryRun,
    summary: outcome.summary,
    data: asJson(outcome.data),
    changes: outcome.changes.map((change) => asJson(change)),
    diagnostics: outcome.diagnostics.map((entry) => asJson(entry)),
    error: asJson(outcome.error),
    durationMs: outcome.durationMs,
  }
}
