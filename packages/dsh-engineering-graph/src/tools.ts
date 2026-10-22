/**
 * The model-facing tools of the engineering-graph plugin.
 *
 * Five tools: `knowledge_workspace` reports the project and its databases (local,
 * no engine), and `knowledge_schema` / `knowledge_ingest` / `knowledge_update` /
 * `knowledge_query` drive the engine's four operations. The engine-backed four
 * return one canonical envelope, so a model always sees `ok`, a one-line
 * `summary`, the engine's structured `data`, the (empty) `changes` /
 * `diagnostics` lists and a structured `error` carrying the engine's code,
 * message and remediation. The discovery tool declares its own envelope instead,
 * because reporting an `operation` the engine never ran would be a lie
 * (`workspace-tool.ts`).
 *
 * **The tool names are deliberate**: `knowledge_schema`, `knowledge_ingest`,
 * `knowledge_update`, `knowledge_query`. They keep the names the origin library
 * (`Tools/KnowledgeTools.cs`, see `engine/Operations.cs`) exposed to a model, so
 * prompts, notes and muscle memory written against that surface keep working after
 * the move into DSH. The DSH house style would be an unprefixed verb_noun
 * (`ingest_exports`), which is exactly the kind of renaming that silently breaks
 * callers, so it was not done. `knowledge_workspace` follows the same prefix.
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
import { recordGraphSidecar } from './graph-freshness.js'
import type { JsonRecord, Operation, ProgressFrame, ResultFrame, ToolError, ToolOutcome } from './protocol.js'
import { workspaceToolDefinition } from './workspace-tool.js'
import { chooseDatabase, type DatabaseChoice } from './workspace.js'
import { drilldownToolDefinitions } from './drilldown-tools.js'

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

/**
 * A bounded comma-separated list, for the per-component path listings an update
 * reports. The full arrays stay in `data`; this only keeps one rendered line from
 * growing without limit when a large batch is refused or reported.
 */
function renderPathList(values: readonly string[]): string {
  const shown = values.slice(0, MAX_LISTED).join(', ')
  return values.length > MAX_LISTED ? `${shown} … (+${values.length - MAX_LISTED} more)` : shown
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

/** Characters kept from one long field value before it is cut (the default). */
const MAX_FIELD_CHARS = 200

/** The largest a caller may raise {@link MAX_FIELD_CHARS} to, still well under the Pruner's 8192. */
const HARD_FIELD_CHARS = 3500

/**
 * Clamps a requested per-field character budget.
 *
 * The cap exists so a wide result stays readable; it is not a claim about how long
 * a value may be. A caller that needs one long text (a network's translated logic,
 * a stored excerpt) raises it deliberately instead of slicing the value with SQL
 * `substr` across a dozen queries.
 *
 * @param value - the caller's `max_field_chars`, if it supplied one.
 * @returns the effective budget, between 40 and {@link HARD_FIELD_CHARS}.
 */
function clampFieldChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_FIELD_CHARS
  return Math.min(Math.max(Math.trunc(value), 40), HARD_FIELD_CHARS)
}

/**
 * Characters the rendered `knowledge_query` rows may occupy.
 *
 * Deliberately far below the framework's Pruner threshold (8192 chars), which cuts
 * the **middle** of an oversized result — the very rows a listing exists for. The
 * budget is spent row by row, and the remainder is reported with the next action
 * ("add LIMIT/OFFSET") instead of pointing at `data`, which the model never sees.
 */
const QUERY_RENDER_BUDGET = 3500

/**
 * Renders query rows as column-named JSON objects, bounded twice: each long value
 * is cut, and the listing stops at {@link QUERY_RENDER_BUDGET}.
 *
 * Column names rather than bare arrays because a model reading `{"name": "Main"}`
 * cannot mis-count which position it is looking at, and because the row shape is
 * exactly what the statement selected.
 *
 * @param rows - the engine's rows, one array per row.
 * @param columns - the column names the engine reported, in order.
 * @returns the lines that fit, how many rows did not, and how many fields were cut.
 */
function renderQueryRows(
  rows: readonly unknown[],
  columns: readonly string[],
  fieldChars: number,
): { lines: string[]; omitted: number; clipped: number } {
  const lines: string[] = []
  let used = 0
  let clipped = 0

  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row]
    const entry: Record<string, unknown> = {}
    values.forEach((value, index) => {
      const key = columns[index] ?? `column${index + 1}`
      if (typeof value === 'string' && value.length > fieldChars) {
        clipped += 1
        entry[key] = `${value.slice(0, fieldChars)}…[${value.length} chars]`
      } else {
        entry[key] = value
      }
    })
    const line = `  ${JSON.stringify(entry)}`
    if (used + line.length > QUERY_RENDER_BUDGET) {
      return { lines, omitted: rows.length - lines.length, clipped }
    }
    lines.push(line)
    used += line.length + 1
  }

  return { lines, omitted: 0, clipped }
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
 * spelling of it; the four the engine can return are exactly the four cases
 * below.
 */
function renderData(operation: string, data: JsonRecord | null, fieldChars = MAX_FIELD_CHARS): string {
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
    case 'Update': {
      const changed = numberOf(data['changed']) ?? 0
      const closure = numberOf(data['closure']) ?? 0
      const removed = numberOf(data['removed']) ?? 0
      lines.push(`Database: ${text(data['dbPath']) ?? '?'}`)
      lines.push(`Replaced: ${changed} changed component(s), plus ${closure} in the dependency closure; removed ${removed}.`)
      const changedPaths = strings(data['changedComponents'])
      if (changedPaths.length > 0) lines.push(`Changed: ${renderPathList(changedPaths)}`)
      const closurePaths = strings(data['closureComponents'])
      if (closurePaths.length > 0) lines.push(`Closure (re-imported so their edges survive): ${renderPathList(closurePaths)}`)
      const removedPaths = strings(data['removedComponents'])
      if (removedPaths.length > 0) lines.push(`Removed: ${renderPathList(removedPaths)}`)
      const ignored = strings(data['ignoredRemovedPaths'])
      if (ignored.length > 0) {
        lines.push(`Ignored (never imported into this database, so nothing to remove): ${renderPathList(ignored)}`)
      }
      lines.push(`Graph now: ${numberOf(data['nodes']) ?? 0} node(s), ${numberOf(data['edges']) ?? 0} edge(s)`)
      break
    }
    case 'Query': {
      const columns = strings(data['columns'])
      const rows = list(data['rows'])
      const rowCount = numberOf(data['rowCount']) ?? rows.length
      lines.push(`Database: ${text(data['dbPath']) ?? '?'}`)
      lines.push(`Columns: ${columns.join(', ') || 'none'}`)
      lines.push(`Rows: ${rowCount}${data['truncated'] === true ? ' — the engine stopped at max_rows' : ''}`)
      const rendered = renderQueryRows(rows, columns, fieldChars)
      lines.push(...rendered.lines)
      if (rendered.omitted > 0) {
        lines.push(
          `… ${rendered.omitted} more row(s) not shown (this tool renders a bounded slice): narrow the statement with a ` +
            'WHERE clause, or page with LIMIT and OFFSET.',
        )
      }
      if (rendered.clipped > 0) {
        lines.push(
          `Long values were cut at ${fieldChars} characters (${rendered.clipped} field(s)); pass a larger ` +
            `max_field_chars (up to ${HARD_FIELD_CHARS}) to read one whole, or select fewer columns.`,
        )
      }
      if (data['truncated'] === true) {
        lines.push('Raise max_rows (hard maximum 1000) or narrow the statement; the engine caps what it reads.')
      }
      break
    }
  }

  return lines.join('\n')
}

// ----------------------------------------------------------------- the envelope

/** The value shape inferred from {@link OUTCOME_SCHEMA}. */
type OutcomeValue = InferValue<typeof OUTCOME_SCHEMA>

/** Bridges the inferred schema value back to the envelope the renderer reads. */
function renderValue(value: OutcomeValue, fieldChars = MAX_FIELD_CHARS): string {
  return renderOutcome(value as unknown as ToolOutcome, fieldChars)
}

/**
 * The single place that turns an engine frame into the model-facing text.
 *
 * @param outcome - the canonical envelope.
 * @param fieldChars - per-value character budget for a query's rows; the tool's
 *   own `max_field_chars` argument, so a caller that asks for a long value gets it.
 */
export function renderOutcome(outcome: ToolOutcome, fieldChars = MAX_FIELD_CHARS): string {
  const header = outcome.ok ? `${outcome.operation} succeeded.` : `${outcome.operation} FAILED.`
  const parts = [header, outcome.summary]
  const detail = renderData(outcome.operation, outcome.data, clampFieldChars(fieldChars))
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
    case 'Update': {
      if (data === null) return 'The knowledge database was updated in place.'
      const changed = numberOf(data['changed']) ?? 0
      const closure = numberOf(data['closure']) ?? 0
      const removed = numberOf(data['removed']) ?? 0
      return (
        `Updated ${changed} changed component(s)` +
        `${closure > 0 ? ` plus ${closure} in the dependency closure` : ''}` +
        `${removed > 0 ? ` and removed ${removed}` : ''} in ${text(data['dbPath']) ?? 'the database'}: ` +
        `${numberOf(data['nodes']) ?? 0} node(s) and ${numberOf(data['edges']) ?? 0} edge(s) now.`
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
 * A refusal this plugin produced itself, in the same envelope an engine refusal
 * arrives in.
 *
 * It exists so `knowledge_query`'s `db_path` resolution can fail without the
 * model seeing a second result shape: the code, the reason and the next step are
 * exactly where `renderOutcome` prints an engine's own error. `durationMs` is 0
 * because no engine time elapsed — reporting the tool's own think time as engine
 * time would be the kind of small fiction this package's documents forbid.
 *
 * @param operation - the operation the tool would have run.
 * @param code - a stable code; the query resolver's own codes are `DB_NOT_FOUND`
 *   and `DB_AMBIGUOUS`, which mean what the engine's `DB_NOT_FOUND` means.
 * @param message - what is wrong, in one sentence.
 * @param remediation - what the model should do next.
 */
function localFailure(operation: Operation, code: string, message: string, remediation: string): ToolOutcome {
  return {
    ok: false,
    operation,
    dryRun: false,
    summary: `${operation} was refused: ${message}`,
    data: null,
    changes: [],
    diagnostics: [],
    error: { code, message, details: { remediation } },
    durationMs: 0,
  }
}

/** The outcome of resolving which database a call runs against. */
type DatabaseChoiceOutcome = { ok: true; path: string } | { ok: false; outcome: ToolOutcome }

/**
 * Decide the database a query runs against.
 *
 * The decision itself lives in `workspace.ts` (D24), because the drill-down tools
 * need exactly the same one; this only maps its refusal into the envelope an
 * engine refusal arrives in.
 *
 * @param explicitPath - the tool argument, if the model supplied one.
 * @param cwd - the session working directory, if the harness supplied one.
 * @returns the absolute path, or the refusal to hand back.
 */
async function resolveQueryDatabase(explicitPath: string | undefined, cwd: string | undefined): Promise<DatabaseChoiceOutcome> {
  const choice = await chooseDatabase(explicitPath, cwd)
  if (choice.ok) return { ok: true, path: choice.path }
  return { ok: false, outcome: localFailure('Query', choice.code, choice.message, choice.remediation) }
}

/**
 * How much of the reading surface a preset gets.
 *
 * `none` — orientation only (workspace, schema, ingest, update, raw query); `inspect` —
 * add the two tools that answer "what is in this block / network"; `all` — add
 * search and variable usage as well, which is the expert's full surface
 * (docs/decisions.md D25).
 */
export type DrilldownSurface = 'none' | 'inspect' | 'all'

/** Options that select which tools become visible, without changing any of them. */
export interface RegisterToolsOptions {
  /**
   * Whether the two database-writing tools (`knowledge_ingest` and
   * `knowledge_update`) are registered. Defaults to `true`, so a caller that says
   * nothing keeps the full surface.
   *
   * A graph rebuild — or an incremental update of it — is a heavy write (one
   * database per device, minutes on a large project), so it belongs to the main
   * agent's project workflow; a read-only subagent preset turns it off and keeps the
   * discovery, schema and query tools. Those are unaffected, and their order and
   * definitions are identical either way.
   */
  includeIngest?: boolean
  /**
   * How much of the drill-down surface is registered. Defaults to `none`.
   *
   * `inspect` is what a main agent needs to brief a delegation without reading
   * SQL for twenty minutes: `knowledge_block` and `knowledge_network` answer
   * "what is in this block / this network" in one bounded call. `all` adds the
   * search and variable-usage tools and is the expert's surface. A literal
   * `true` still means `all` and `false` still means `none`, so an older profile
   * keeps working (docs/decisions.md D25).
   */
  includeDrilldown?: DrilldownSurface | boolean
}

/**
 * Registers every tool of this plugin on `ctx.tools`. The framework owns the
 * registrations, so their disposers are not managed here.
 *
 * Registration order is the order the model reads them in, so it follows the
 * work: find the project and its databases (`knowledge_workspace`), learn the
 * schema (`knowledge_schema`), build or refresh a database (`knowledge_ingest`,
 * `knowledge_update`, optional together), then ask a question (`knowledge_query`).
 *
 * @param ctx - the context whose `ctx.tools` receives the definitions.
 * @param dependencies - the engine seam every engine-backed tool body runs against.
 * @param options - which tools to register; omitted means all of them.
 * @returns the registered tool names, in registration order.
 */
export function registerTools(ctx: Context, dependencies: ToolDependencies, options: RegisterToolsOptions = {}): string[] {
  // Only a literal `false` removes the ingest tool, and `includeDrilldown` accepts
  // the three surface names plus the older booleans: an omitted or untyped value
  // keeps today's behaviour, so an untyped caller cannot silently change an
  // agent's surface in either direction.
  const includeIngest = options.includeIngest !== false
  const drilldown = normalizeDrilldown(options.includeDrilldown)
  const registered: string[] = []

  const register = (definition: ToolDefinition): void => {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }

  // The only tool here that needs no engine, and the only one that answers
  // "which database?" — so it is registered first, and it is available to every
  // preset including the ones that cannot ingest.
  register(workspaceToolDefinition)

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

  // The tools a read-only preset must not see. Skipping the whole definitions
  // (rather than registering bodies that refuse) is deliberate: a tool the model
  // cannot call at all is a clearer boundary than one that answers "no", and the
  // other tools keep their names, order and definitions untouched.
  if (includeIngest) {
    register(
      defineTool({
        name: 'knowledge_ingest',
        description:
          "Build (or rebuild) ONE device's knowledge database: read the export manifest in the device folder, parse " +
          'every source file it lists into a graph of nodes and edges, and write it to a SQLite database. It is a full ' +
          'rebuild, so point db_path at a database this tool owns. Call it once per device -- a project with several ' +
          'PLCs has one folder per device under source/. Progress is reported while the files are parsed and the ' +
          'database is written. A successful rebuild also records the export ledger\'s PLC checksum in ' +
          '.dsh/local/graph/<device>.json, which is what makes knowledge_workspace report the database as fresh or ' +
          'stale afterwards. Fails with DEVICE_DIR_REQUIRED, DEVICE_DIR_NOT_FOUND, NO_SOURCE_FILES or ' +
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
          const outcome = await runOperation(dependencies, 'Ingest', params, {
            signal: exec.signal,
            // The engine reports what it is crawling and where it is writing.
            // Turning that into debug lines is what makes a slow ingest visible in
            // the plugin log without changing the tool result.
            onProgress: (frame) => dependencies.log.debug(`engine ingest [${frame.phase}] ${frame.message}`),
          })

          // Same writer as the `knowledgeGraph` service: the tool drives the engine
          // directly, so it has to leave the same provenance file, or a database
          // rebuilt from here would report `unknown` forever. A failed ingest
          // (outcome.ok false) must not touch the sidecar.
          if (outcome.ok) {
            await recordGraphSidecar(args.device_dir, { log: dependencies.log })
          }

          return asJsonOutcome(outcome)
        },
      }),
    )

    // The incremental sibling of knowledge_ingest: same heavy-write surface, so it
    // is registered (or withheld) with it. A conservative refresh of a few blocks is
    // still a write to a device database, and the read-only subagent presets must not
    // be able to start one any more than they can start a full rebuild.
    register(
      defineTool({
        name: 'knowledge_update',
        description:
          'Refresh ONE device\'s knowledge database for the files a sync changed or removed, without re-parsing the ' +
          'whole export. It re-imports each named component and replaces its slice of the graph, plus one dependency ' +
          'hop: every component that owns an edge pointing at a node of a changed or removed component is re-imported ' +
          'too, because replacing a component can otherwise strip a neighbour\'s edge. The whole batch is one ' +
          'transaction, so a failure leaves the previous database intact. It is deliberately conservative and never ' +
          'falls back on its own: a database without component provenance is refused with ' +
          'UPDATE_REQUIRES_FULL_REBUILD, a changed path the database never imported with UPDATE_UNKNOWN_COMPONENT, a ' +
          'component whose stored identity moved (a block moved to another group) with UPDATE_IDENTITY_CHANGED, a ' +
          'batch over max_components with UPDATE_TOO_LARGE, and a changed file that no longer exists with ' +
          'UPDATE_SOURCE_MISSING — in every one of those cases call knowledge_ingest instead. Only direct block XML ' +
          'changes are the supported incremental case; type-wide or tag-table changes are the caller\'s decision to ' +
          'force a full ingest. A successful update records the export ledger\'s PLC checksum in ' +
          '.dsh/local/graph/<device>.json exactly like knowledge_ingest.',
        parameters: {
          device_dir: {
            type: 'string',
            required: true,
            description:
              'Absolute path of the device folder the database was built from, i.e. <project>/source/<device>. It ' +
              'must still exist (the changed components are re-imported from it); a missing folder is ' +
              'DEVICE_DIR_NOT_FOUND.',
          },
          changed_paths: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description:
              'Device-relative paths of the files whose content changed, e.g. ["blocks/010_Cell/FC.xml"]. Forward or ' +
              'back slashes are both accepted. Pass an empty array when only files were removed. Each path must be the ' +
              'relative_path of a component the database already has, otherwise UPDATE_UNKNOWN_COMPONENT.',
          },
          removed_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Device-relative paths of the files deleted from the tree. A path the database never imported is ' +
              'reported in data.ignoredRemovedPaths and ignored, so a sync may name every deletion it saw.',
          },
          db_path: {
            type: 'string',
            description:
              'Absolute path of the database to update. Omit for <project>/knowledge/<device>/<device>_knowledge.db, ' +
              'the same default knowledge_ingest uses. It must already exist and carry component provenance.',
          },
          max_components: {
            type: 'integer',
            description:
              'Upper bound on how many components this call may touch (changed + dependency closure + removed), ' +
              'default 50. A wider batch is refused with UPDATE_TOO_LARGE: at that size a full knowledge_ingest is ' +
              'cheaper and cannot drift.',
          },
        },
        output: {
          schema: OUTCOME_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
        },
        presentCall: (args) => ({
          card: 'generic',
          title: 'Update engineering graph (incremental)',
          kind: 'other',
          rawInput: args,
        }),
        async execute(args, exec) {
          const params: JsonRecord = { deviceDir: args.device_dir, changedPaths: args.changed_paths }
          if (args.removed_paths !== undefined) params['removedPaths'] = args.removed_paths
          if (args.db_path !== undefined) params['dbPath'] = args.db_path
          if (args.max_components !== undefined) params['maxComponents'] = args.max_components

          const outcome = await runOperation(dependencies, 'Update', params, {
            signal: exec.signal,
            // One note per component, so a slow batch is visible in the plugin log.
            onProgress: (frame) => dependencies.log.debug(`engine update [${frame.phase}] ${frame.message}`),
          })

          // The same sidecar writer the service uses: a database refreshed here must be
          // able to report `fresh`, and a refused update must not touch the sidecar.
          if (outcome.ok) {
            await recordGraphSidecar(args.device_dir, { log: dependencies.log })
          }

          return asJsonOutcome(outcome)
        },
      }),
    )
  }

  register(
    defineTool({
      name: 'knowledge_query',
      description:
        'Run one read-only SQL statement against a knowledge database built by knowledge_ingest and return the rows. ' +
        'The statement must be a single read-only SELECT, WITH or EXPLAIN — anything else (including DROP, INSERT or ' +
        'UPDATE, and more than one statement) is refused with QUERY_REJECTED, and the database is opened read-only ' +
        'as a backstop. knowledge_schema documents the tables (graph_nodes, graph_edges and the rest), their columns ' +
        'and worked example queries; call it first when you are unsure, and note that an unknown table or column ' +
        'fails with QUERY_INVALID_SQL, which names the tables that do exist. Reach for the drill-down tools ' +
        '(knowledge_search, knowledge_block, knowledge_network, knowledge_variable_usage) when the question is about a ' +
        'block, a network or a variable: they run the fixed statements and shape the answer, while this tool is the ' +
        'escape hatch for everything else. The reply renders a bounded slice of the rows (long values are cut, and it ' +
        'says how many rows it left out) — page with LIMIT and OFFSET rather than asking for a whole table, and raise ' +
        'max_field_chars when one long value (a network logic text, a stored excerpt) must be read whole. max_rows ' +
        'caps what the engine reads (default 200, hard maximum 1000) and a capped result says so.',
      parameters: {
        db_path: {
          type: 'string',
          description:
            'The SQLite database to query. Omit it and the workspace is resolved for you: when exactly one device in ' +
            'this workspace has a knowledge database, that database is used; with none or several the call is refused ' +
            'with DB_NOT_FOUND or DB_AMBIGUOUS, whose remediation names the candidates (knowledge_workspace lists ' +
            'them all). A relative path is resolved against the session working directory.',
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
        max_field_chars: {
          type: 'integer',
          description:
            `Characters kept from one long value (default ${MAX_FIELD_CHARS}, maximum ${HARD_FIELD_CHARS}). Raise it to ` +
            'read a single long value whole instead of slicing it with substr across several queries.',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (args, value) => [{ type: 'text', text: renderValue(value, args.max_field_chars) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Query engineering graph',
        kind: 'read',
        rawInput: args,
      }),
      async execute(args, exec) {
        const database = await resolveQueryDatabase(args.db_path, exec.agent?.session?.header?.cwd)
        if (!database.ok) return asJsonOutcome(database.outcome)

        const params: JsonRecord = { dbPath: database.path, sql: args.sql }
        if (args.max_rows !== undefined) params['maxRows'] = args.max_rows
        return asJsonOutcome(await runOperation(dependencies, 'Query', params, { signal: exec.signal }))
      },
    }),
  )

  // The reading surface, off unless a preset asks for it. Registered last so the
  // shared orientation/write/query names keep their order.
  if (drilldown !== 'none') {
    for (const definition of drilldownToolDefinitions(dependencies, drilldown)) register(definition)
  }

  return registered
}

/**
 * Normalizes `includeDrilldown` from a profile, a test or a caller.
 *
 * Accepts the three surface names, and the two booleans the option used to take
 * (`true` = `all`, `false` = `none`) so an existing profile keeps its meaning.
 * Anything else is `none`: a typo must not quietly hand an agent a surface it was
 * not meant to have.
 *
 * @param value - whatever the caller supplied.
 * @returns the surface to register.
 */
export function normalizeDrilldown(value: DrilldownSurface | boolean | undefined): DrilldownSurface {
  if (value === true) return 'all'
  if (value === false || value === undefined) return 'none'
  return value === 'all' || value === 'inspect' ? value : 'none'
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
