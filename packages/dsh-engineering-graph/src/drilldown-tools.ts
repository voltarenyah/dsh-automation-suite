/**
 * The four drill-down tools: `knowledge_search`, `knowledge_block`,
 * `knowledge_network`, `knowledge_variable_usage`.
 *
 * They are the "answer the question" surface over the derived tables the engine
 * already builds (`knowledge_networks`, `knowledge_network_accesses`,
 * `knowledge_search`), and they are **composed in TypeScript**: each tool issues
 * one or more ordinary `Query` calls through the existing engine operation, so
 * adding them touched no C#, no protocol whitelist and no shipped `engine/bin`
 * (docs/decisions.md **D24** §5). What they add over handing the model raw SQL is
 * the part that used to go wrong: the statements are fixed and escaped, the rows
 * are shaped, and the render is bounded — the framework delivers only `render`
 * text, and it prunes an oversized result by cutting its **middle**.
 *
 * Distribution (D24 §4): the `expert` subagent declares the row with
 * `includeDrilldown: true` and gets all four; the `leader` keeps the workspace,
 * schema, ingest and raw-query tools and delegates deep reading instead.
 *
 * @module dsh-engineering-graph/drilldown-tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  blockNetworksStatement,
  blockPropertiesStatement,
  blockStatement,
  chunkLogic,
  clampChars,
  clampRows,
  DEFAULT_LOGIC_CHARS,
  fitDetails,
  HARD_ROWS,
  intCell,
  mapRows,
  mentionStatement,
  networkAccessStatement,
  networksByIdsStatement,
  networkStatement,
  renderCount,
  searchStatement,
  textCell,
  unusableValue,
  variableAccessStatement,
  variableNodesStatement,
  type AccessRecord,
  type NetworkSummary,
  type SearchMatch,
} from './drilldown.js'
import { asWireOutcome, localFailure, localSuccess, localOutcomeSchema, renderLocalOutcome, type LocalOutcome } from './local-outcome.js'
import type { JsonRecord, ResultFrame } from './protocol.js'
import { chooseDatabase } from './workspace.js'

/** The engine seam every drill-down tool body needs. */
export interface DrilldownDependencies {
  request(
    operation: 'Query',
    params: JsonRecord,
    options?: { signal?: AbortSignal },
  ): Promise<ResultFrame>
}

/** Characters of auxiliary detail lines, leaving room for the logic payload. */
const AUX_CHARS = 900

/**
 * Characters of the network list in `knowledge_block`.
 *
 * Deliberately above the auxiliary budget: an SCL block is listed as one row per
 * REGION (the largest has 89), and the fixed 900-character budget showed about
 * twelve of them no matter how far `max_networks` was raised (docs/decisions.md
 * D27). 3,500 keeps the whole reply under the framework's 8,192-character Pruner
 * threshold, which cuts the MIDDLE of an oversized result.
 */
const NETWORK_DETAIL_CHARS = 3500

/**
 * Characters of a `knowledge_network` header.
 *
 * Above the auxiliary budget because the header carries the region path, the
 * enclosing control structures, and both bounded variable lists: at 900 a region
 * that writes 130 variables pushed `Reads`, `Logic:` and `TIA network:` off the
 * list, so the model never learned which character range it was reading
 * (docs/decisions.md D27). 1,400 + the 6,000-character logic cap + the NEXT line
 * stays under the framework's 8,192-character Pruner threshold.
 */
const LEAD_CHARS = 1400

/** The D27 segment kind; `network` for a LAD/FBD network or a database built before D27. */
function segmentKindOf(network: NetworkSummary): string {
  return (network.segmentKind ?? 'network').toLowerCase()
}

/** `LAD`, `SCL region`, `SCL part` — what the block listing shows in parentheses. */
function segmentLabel(network: NetworkSummary): string {
  const language = network.language ?? 'unknown language'
  const kind = segmentKindOf(network)
  return kind === 'network' ? language : `${language} ${kind}`
}

/**
 * Names per direction in a `knowledge_network` header.
 *
 * A region can read 130 variables or write 350; joined whole, that one line
 * overflowed the auxiliary budget and `fitDetails` dropped it — and every line
 * after it, including `Logic:` — so the model saw the counts in the summary but
 * no names at all (docs/decisions.md D27).
 */
const ACCESS_NAMES_SHOWN = 12

/** A bounded, comma-joined name list: `a, b, c … (+118 more)`. */
function summarizeNames(names: readonly string[]): string {
  if (names.length === 0) return 'none'
  const shown = names.slice(0, ACCESS_NAMES_SHOWN).join(', ')
  if (names.length <= ACCESS_NAMES_SHOWN) return shown
  return `${shown} … (+${names.length - ACCESS_NAMES_SHOWN} more)`
}

/** The result of one `Query` the drill-down layer issued. */
interface QueryRows {
  rows: unknown[][]
  columns: string[]
  /** True when the engine stopped at its own row cap. */
  truncated: boolean
}

/** A refusal: either this plugin's own code or the engine's. */
interface QueryRefusal {
  code: string
  message: string
  remediation: string | null
}

/**
 * Runs one statement and returns its rows, or the coded refusal.
 *
 * A **transport** failure still throws: the engine never answered, and pretending
 * that is an operation outcome would hide it (the same rule the engine-envelope
 * tools follow).
 */
async function runQuery(
  dependencies: DrilldownDependencies,
  dbPath: string,
  sql: string,
  maxRows: number,
  signal: AbortSignal | undefined,
): Promise<QueryRows | QueryRefusal> {
  const frame = await dependencies.request('Query', { dbPath, sql, maxRows }, { signal })
  if (!frame.ok) {
    return {
      code: frame.error?.code ?? 'unknown_failure',
      message: frame.error?.message ?? 'The engine reported a failure without detail.',
      remediation: frame.error?.remediation ?? null,
    }
  }
  const data = frame.data ?? {}
  const rows = Array.isArray(data['rows']) ? (data['rows'] as unknown[][]) : []
  const columns = Array.isArray(data['columns']) ? (data['columns'] as string[]) : []
  return { rows, columns, truncated: data['truncated'] === true }
}

/** Whether a `runQuery` result is a refusal. */
function refused(result: QueryRows | QueryRefusal): result is QueryRefusal {
  return (result as QueryRefusal).code !== undefined
}

/** The database to run against, or the outcome to hand back. */
async function databaseFor(
  dbPath: string | undefined,
  cwd: string | undefined,
  tool: string,
): Promise<{ ok: true; path: string } | { ok: false; outcome: LocalOutcome }> {
  const choice = await chooseDatabase(dbPath, cwd)
  if (choice.ok) return { ok: true, path: choice.path }
  return { ok: false, outcome: localFailure(tool, choice.code, choice.message, choice.remediation) }
}

/**
 * Runs one tool body against the database the workspace resolves to.
 *
 * The tool name travels as an argument rather than as module state: two tool
 * bodies can run concurrently in one process, so a mutable "current tool" would
 * attribute a refusal to whichever call happened to run last.
 *
 * @param tool - the tool name, used to attribute a resolution refusal.
 * @param cwd - the session working directory.
 * @param build - the body, given the resolved absolute database path.
 * @param explicitPath - the model's `db_path`, if it supplied one.
 */
async function body(
  tool: string,
  cwd: string | undefined,
  build: (dbPath: string) => Promise<LocalOutcome>,
  explicitPath?: string,
): Promise<LocalOutcome> {
  const database = await databaseFor(explicitPath, cwd, tool)
  if (!database.ok) return database.outcome
  return await build(database.path)
}

/** A refusal raised by a tool body itself. */
function refuse(tool: string, code: string, message: string, remediation: string | null): LocalOutcome {
  return localFailure(tool, code, message, remediation)
}

/** The `db_path` parameter every drill-down tool shares. */
const DB_PATH_PARAMETER = {
  type: 'string',
  description:
    'The knowledge database to read. Omit it and the workspace resolves it: one device with a database is used, none ' +
    'or several is refused (DB_NOT_FOUND / DB_AMBIGUOUS) with the candidates named. knowledge_workspace lists them.',
} as const

/** One row of a block or variable-usage listing, spelled for a detail line. */
function site(block: string, index: number | null, extra: string): string {
  return `${block}${index === null ? '' : `[${index}]`} ${extra}`
}

// ------------------------------------------------------------------- search

const SEARCH_TOOL = 'knowledge_search'

function searchTool(dependencies: DrilldownDependencies): ToolDefinition {
  return defineTool({
  name: SEARCH_TOOL,
  description:
    'Find where a text occurs in the knowledge graph: node names, network titles and the translated network logic. ' +
    'Use it when the user names a block, tag or DB member imprecisely and you need the exact object before guessing. ' +
    'The response lists matches as [nodeKind] name (matchedIn) plus a snippet, so you can pick one and continue with ' +
    'knowledge_block or knowledge_network. Needs at least 3 characters for the indexed search; shorter text falls ' +
    'back to a slower LIKE scan (reported as a warning). max_rows caps matches (default 50, hard maximum 200).',
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: 'Substring to find in node names, network titles or translated logic.',
    },
    kind: {
      type: 'string',
      description: "Optional node-kind filter, for example 'Network', 'FB', 'Variable', 'DB Member'.",
    },
    max_rows: {
      type: 'integer',
      description: 'Maximum matches to return (default 50, hard maximum 200).',
    },
    db_path: DB_PATH_PARAMETER,
  },
  output: {
    schema: localOutcomeSchema('Matches for one text, with the field each match came from.'),
    render: (_args, value) => [{ type: 'text', text: renderLocalOutcome(value as unknown as LocalOutcome) }],
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `Search the knowledge graph${args.kind === undefined ? '' : ` (${args.kind})`}`,
    kind: 'read',
    rawInput: args,
  }),
  async execute(args, exec) {
    const tool = SEARCH_TOOL
    const invalid = unusableValue(args.text, 'Search text')
    if (invalid !== null) return asWireOutcome(refuse(tool, 'SEARCH_TEXT_INVALID', invalid, 'Pass a plain substring.'))

    return asWireOutcome(
      await body(
        tool,
        exec.agent?.session?.header?.cwd,
        async (dbPath) => {
          const limit = clampRows(args.max_rows)
          const statement = searchStatement(args.text, args.kind, limit + 1)
          const result = await runQuery(dependencies, dbPath, statement.sql, limit + 1, exec.signal)
          if (refused(result)) return localFailure(tool, result.code, result.message, result.remediation)

          const matches = mapRows(result.rows, (row): SearchMatch => ({
            nodeId: textCell(row, 0) ?? '',
            kind: textCell(row, 1) ?? '',
            name: textCell(row, 2) ?? '',
            field: textCell(row, 3) ?? '',
            snippet: textCell(row, 4),
          }))
          const truncated = matches.length > limit
          const shown = truncated ? matches.slice(0, limit) : matches

          const lines = shown.map((match) => {
            const snippet = match.snippet === null || match.snippet.length === 0 ? '' : ` — ${oneLine(match.snippet)}`
            return `- [${match.kind}] ${match.name} (${match.field})${snippet}`
          })
          const fitted = fitDetails(lines, 3500)
          const details = [`Database: ${dbPath}`, `Matches: ${shown.length}${truncated ? ' (more than shown)' : ''}`, ...fitted.lines]
          if (fitted.omitted > 0) details.push(`… ${fitted.omitted} more match(es) not shown; narrow the search or raise max_rows.`)
          if (truncated) {
            details.push(
              `The search stopped at max_rows (${limit}); raise max_rows (hard maximum ${HARD_ROWS}) or narrow the text.`,
            )
          }

          const warnings: string[] = []
          if (!statement.fullText) {
            warnings.push('The text is shorter than 3 characters, so the indexed search could not be used and a LIKE scan ran instead.')
          }

          return localSuccess(
            tool,
            `${shown.length} match(es) for '${args.text}' in ${dbPath}${truncated ? ' (capped)' : ''}.`,
            details,
            {
              dbPath,
              text: args.text,
              kind: args.kind ?? null,
              fullText: statement.fullText,
              matches: shown,
              returned: shown.length,
              truncated,
            },
            warnings,
          )
        },
        args.db_path,
      ),
    )
  },
})
}

// -------------------------------------------------------------------- block

const BLOCK_TOOL = 'knowledge_block'

/** Resolves a block name to its node, or the refusal to hand back. */
async function resolveBlock(
  dependencies: DrilldownDependencies,
  dbPath: string,
  block: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; id: string; kind: string; name: string } | { ok: false; outcome: LocalOutcome }> {
  const result = await runQuery(dependencies, dbPath, blockStatement(block), 5, signal)
  if (refused(result)) {
    return { ok: false, outcome: localFailure(BLOCK_TOOL, result.code, result.message, result.remediation) }
  }
  const candidates = mapRows(result.rows, (row) => ({
    id: textCell(row, 0) ?? '',
    kind: textCell(row, 1) ?? '',
    name: textCell(row, 2) ?? '',
  }))
  if (candidates.length === 0) {
    return {
      ok: false,
      outcome: localFailure(
        BLOCK_TOOL,
        'BLOCK_NOT_FOUND',
        `No program block named '${block}' is in this database.`,
        'Call knowledge_search with a fragment of the name (for example kind=\'FB\') to find the exact one.',
      ),
    }
  }
  const exact = candidates.find((candidate) => candidate.name === block) ?? candidates[0]!
  return { ok: true, ...exact }
}

function blockTool(dependencies: DrilldownDependencies): ToolDefinition {
  return defineTool({
  name: BLOCK_TOOL,
  description:
    'Describe one program block (OB/FB/FC): its graph node, its properties (source file, language, …) and a compact list ' +
    'of its networks with each network index, title, language and logic size. A pure SCL block is listed by REGION: each ' +
    'row is one REGION (the SCL equivalent of a network), titled with its region path, and a row marked `part` is a slice ' +
    'of one REGION bigger than 6,000 characters. Use it to decide which network or region to read, then call ' +
    'knowledge_network for one of them. The block name is matched case-insensitively but exactly — use ' +
    'knowledge_search when you only have a fragment. Fails with BLOCK_NOT_FOUND when no such block exists.',
  parameters: {
    block: {
      type: 'string',
      required: true,
      description: "Exact block name, for example 'Main' or 'FB_LAD_SimulateCylinder'.",
    },
    max_networks: {
      type: 'integer',
      description: 'Maximum networks to list (default 50, hard maximum 200).',
    },
    db_path: DB_PATH_PARAMETER,
  },
  output: {
    schema: localOutcomeSchema('One block: its node, its properties and a compact list of its networks.'),
    render: (_args, value) => [{ type: 'text', text: renderLocalOutcome(value as unknown as LocalOutcome) }],
  },
  presentCall: (args) => ({ card: 'generic', title: `Block ${args.block}`, kind: 'read', rawInput: args }),
  async execute(args, exec) {
    const tool = BLOCK_TOOL
    const invalid = unusableValue(args.block, 'Block name')
    if (invalid !== null) return asWireOutcome(refuse(tool, 'BLOCK_INVALID', invalid, 'Pass the exact block name.'))

    return asWireOutcome(
      await body(
        tool,
        exec.agent?.session?.header?.cwd,
        async (dbPath) => {
          const resolved = await resolveBlock(dependencies, dbPath, args.block, exec.signal)
          if (!resolved.ok) return { ...resolved.outcome, tool }

          const propertyResult = await runQuery(dependencies, dbPath, blockPropertiesStatement(resolved.id, 40), 40, exec.signal)
          if (refused(propertyResult)) {
            return localFailure(tool, propertyResult.code, propertyResult.message, propertyResult.remediation)
          }
          const properties = mapRows(propertyResult.rows, (row) => ({
            name: textCell(row, 0) ?? '',
            value: textCell(row, 1) ?? '',
          }))

          const limit = clampRows(args.max_networks)
          const networkResult = await runQuery(
            dependencies,
            dbPath,
            blockNetworksStatement(resolved.id, limit + 1),
            limit + 1,
            exec.signal,
          )
          if (refused(networkResult)) {
            return localFailure(tool, networkResult.code, networkResult.message, networkResult.remediation)
          }
          const networks = mapRows(networkResult.rows, (row): NetworkSummary => ({
            index: intCell(row, 0),
            networkId: textCell(row, 1) ?? '',
            title: textCell(row, 2),
            language: textCell(row, 3),
            logicChars: intCell(row, 4) ?? 0,
            sourceFile: textCell(row, 5),
            commented: (textCell(row, 6) ?? '').trim().toLowerCase() === 'true',
            regionPath: textCell(row, 7),
            segmentKind: textCell(row, 8),
          }))
          // The totals come from the statement, never from the page size: reporting
          // the page as the block's network count made a caller raise max_networks
          // 50 -> 60 -> 70 while the block had 72 (docs/decisions.md D26).
          const first = networkResult.rows[0]
          const total = (first === undefined ? null : intCell(first, 9)) ?? networks.length
          const commentedTotal = (first === undefined ? null : intCell(first, 10)) ?? networks.filter((network) => network.commented).length
          const shown = networks.slice(0, limit)
          const truncated = shown.length < total
          const regions = shown.filter((network) => segmentKindOf(network) === 'region').length

          const sourceFile = properties.find((property) => property.name === 'sourceFile')?.value ?? shown[0]?.sourceFile ?? null
          const details = [
            `Database: ${dbPath}`,
            `Block: ${resolved.name} (${resolved.kind}) — ${resolved.id}`,
            ...(sourceFile === null ? [] : [`Source file: ${sourceFile}`]),
            ...(properties.length === 0
              ? []
              : [`Properties: ${properties.map((property) => `${property.name}=${property.value}`).join('; ')}`]),
            `Networks: ${shown.length} of ${total}${truncated ? ` (first page; raise max_networks to see the rest)` : ''}` +
              (commentedTotal === 0 ? '' : `, ${commentedTotal} commented out (no executable logic)`),
            ...(regions === 0
              ? []
              : [
                  'SCL segmentation: each row is one REGION (or a module/part slice of one); read one with knowledge_network.',
                ]),
          ]
          const fitted = fitDetails(
            shown.map(
              (network) =>
                `- [${network.index ?? '?'}] ${network.title ?? '(untitled)'} (${segmentLabel(network)}), ` +
                `${renderCount(network.logicChars)} logic char(s)${network.commented ? ', COMMENTED OUT' : ''}`,
            ),
            NETWORK_DETAIL_CHARS,
          )
          details.push(...fitted.lines)
          if (fitted.omitted > 0) details.push(`… ${fitted.omitted} more network(s) not shown; raise max_networks.`)
          if (shown.length > 0) {
            details.push('Next step: knowledge_network with this block and one index reads that network in full.')
          }

          return localSuccess(
            tool,
            `${resolved.name} (${resolved.kind}): ${total} network(s)` +
              `${truncated ? `, first ${shown.length} listed` : ''}${commentedTotal === 0 ? '' : `, ${commentedTotal} commented out`}.`,
            details,
            {
              dbPath,
              block: { id: resolved.id, kind: resolved.kind, name: resolved.name },
              properties,
              networks: shown,
              total,
              commentedTotal,
              returned: shown.length,
              truncated,
            },
          )
        },
        args.db_path,
      ),
    )
  },
})
}

// ------------------------------------------------------------------ network

const NETWORK_TOOL = 'knowledge_network'

function networkTool(dependencies: DrilldownDependencies): ToolDefinition {
  return defineTool({
  name: NETWORK_TOOL,
  description:
    'Read exactly one PLC network: its title, language and source file, the variables it reads and writes, and its ' +
    'translated logic. For an SCL block the unit is one REGION (a row of knowledge_block); the reply names the region ' +
    'path, the TIA network it came from, and the enclosing control structures when the region opens inside an IF/CASE. ' +
    'Call it when the block and the 1-based index are already known (knowledge_block lists them); do not list a whole ' +
    'block first when the index is known. The logic is returned in chunks: when the reply says it has more, call again ' +
    'with the returned nextOffset until hasMore is false — never treat a partial chunk as the whole network. Fails with ' +
    'BLOCK_NOT_FOUND or NETWORK_NOT_FOUND.',
  parameters: {
    block: {
      type: 'string',
      required: true,
      description: "Exact block name, for example 'Main'.",
    },
    index: {
      type: 'integer',
      required: true,
      description: '1-based network index inside that block. For an SCL block: the REGION/segment index knowledge_block listed.',
    },
    offset: {
      type: 'integer',
      description: 'Zero-based character offset into the translated logic (default 0).',
    },
    max_chars: {
      type: 'integer',
      description: `Characters of logic to return (default ${DEFAULT_LOGIC_CHARS}, hard maximum 6000).`,
    },
    db_path: DB_PATH_PARAMETER,
  },
  output: {
    schema: localOutcomeSchema('One network: metadata, variable accesses and a bounded slice of its translated logic.'),
    render: (_args, value) => [{ type: 'text', text: renderLocalOutcome(value as unknown as LocalOutcome) }],
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `${args.block}[${args.index}]`,
    kind: 'read',
    rawInput: args,
  }),
  async execute(args, exec) {
    const tool = NETWORK_TOOL
    const invalid = unusableValue(args.block, 'Block name')
    if (invalid !== null) return asWireOutcome(refuse(tool, 'BLOCK_INVALID', invalid, 'Pass the exact block name.'))
    if (!Number.isInteger(args.index) || args.index < 1) {
      return asWireOutcome(
        refuse(tool, 'NETWORK_INDEX_INVALID', `Network index must be a positive integer, got ${String(args.index)}.`, 'knowledge_block lists a block\'s 1-based indices.'),
      )
    }

    return asWireOutcome(
      await body(
        tool,
        exec.agent?.session?.header?.cwd,
        async (dbPath) => {
          const resolved = await resolveBlock(dependencies, dbPath, args.block, exec.signal)
          if (!resolved.ok) return { ...resolved.outcome, tool }

          const result = await runQuery(dependencies, dbPath, networkStatement(resolved.id, args.index), 2, exec.signal)
          if (refused(result)) return localFailure(tool, result.code, result.message, result.remediation)
          const row = result.rows[0]
          if (row === undefined) {
            return localFailure(
              tool,
              'NETWORK_NOT_FOUND',
              `${resolved.name} has no network ${args.index}.`,
              'Call knowledge_block with this block to list the indices it does have.',
            )
          }

          const networkId = textCell(row, 0) ?? ''
          const title = textCell(row, 1)
          const language = textCell(row, 2)
          const compileUnitId = textCell(row, 3)
          const sourceFile = textCell(row, 4)
          const logic = textCell(row, 5)
          const commentedLogic = textCell(row, 6)
          const commentedOut = (textCell(row, 7) ?? '').trim().toLowerCase() === 'true'
          const regionPath = textCell(row, 8)
          const segmentKind = textCell(row, 9)
          const tiaNetworkIndex = intCell(row, 10)
          const enclosingControl = textCell(row, 11)
          const isRegion = (segmentKind ?? '').toLowerCase() === 'region'

          const accessResult = await runQuery(dependencies, dbPath, networkAccessStatement(networkId, HARD_ROWS + 1), HARD_ROWS + 1, exec.signal)
          if (refused(accessResult)) return localFailure(tool, accessResult.code, accessResult.message, accessResult.remediation)
          const accesses = mapRows(accessResult.rows, (access): AccessRecord => ({
            access: textCell(access, 0) ?? '',
            variable: textCell(access, 1) ?? '',
          }))
          const accessesTruncated = accesses.length > HARD_ROWS
          const shownAccesses = accessesTruncated ? accesses.slice(0, HARD_ROWS) : accesses
          const reads = shownAccesses.filter((access) => access.access.toUpperCase() === 'READS').map((access) => access.variable)
          const writes = shownAccesses.filter((access) => access.access.toUpperCase() === 'WRITES').map((access) => access.variable)

          const maxChars = clampChars(args.max_chars)
          const chunk = chunkLogic(logic, args.offset ?? 0, maxChars)

          const lead = [
            `Database: ${dbPath}`,
            `Block: ${resolved.name} (${resolved.kind}) — ${resolved.id}`,
            `Network: ${args.index}${title === null ? '' : ` — ${title}`} (${language ?? 'unknown language'})`,
            ...(isRegion && regionPath !== null ? [`Region: ${regionPath}`] : []),
            ...(enclosingControl === null || enclosingControl.length === 0
              ? []
              : [`Context: inside ${enclosingControl}`]),
            ...(sourceFile === null ? [] : [`Source file: ${sourceFile}`]),
            ...(compileUnitId === null ? [] : [`Compile unit: ${compileUnitId}`]),
            ...(tiaNetworkIndex === null ? [] : [`TIA network: ${tiaNetworkIndex}`]),
            ...(commentedOut
              ? ['Executable logic: NONE — the whole network source is a comment; nothing in it runs.']
              : []),
            `Writes (${writes.length}): ${summarizeNames(writes)}`,
            `Reads (${reads.length}): ${summarizeNames(reads)}`,
            `Logic: characters ${chunk.offset}–${chunk.offset + chunk.text.length} of ${renderCount(chunk.totalChars)}`,
          ]
          const fitted = fitDetails(lead, LEAD_CHARS)
          const details = [...fitted.lines]
          if (fitted.omitted > 0) details.push(`… ${fitted.omitted} more line(s) not shown`)
          details.push(chunk.text.length === 0 ? 'Logic: (empty)' : chunk.text)
          if (commentedOut && commentedLogic !== null) {
            const commented = fitDetails(commentedLogic.split('\n').map((line) => `  ${line}`), AUX_CHARS)
            details.push('Commented-out source (kept for review, NOT executed):')
            details.push(...commented.lines)
            if (commented.omitted > 0) details.push(`  … ${commented.omitted} more commented line(s) in data.commentedSource`)
          }
          if (chunk.hasMore) {
            // A machine-readable next action, so the reply is not "read the last
            // line of the detail list" but an instruction the model can copy.
            details.push(
              `NEXT: knowledge_network(block=${JSON.stringify(resolved.name)}, index=${args.index}, ` +
                `offset=${chunk.nextOffset}, max_chars=${maxChars})`,
            )
          }

          const label =
            isRegion && regionPath !== null ? `${resolved.name}[${args.index}] ${regionPath}` : `${resolved.name}[${args.index}]`

          return localSuccess(
            tool,
            commentedOut
              ? `${label}: no executable logic — the source is commented out.`
              : `${label}: ${writes.length} write(s), ${reads.length} read(s)` +
                (chunk.hasMore
                  ? `, PARTIAL ${chunk.offset}–${chunk.offset + chunk.text.length} of ${renderCount(chunk.totalChars)} logic char(s).`
                  : `, ${renderCount(chunk.totalChars)} logic char(s).`),
            details,
            {
              dbPath,
              block: { id: resolved.id, kind: resolved.kind, name: resolved.name },
              network: {
                networkId,
                index: args.index,
                title,
                language,
                compileUnitId,
                sourceFile,
                regionPath,
                segmentKind,
                tiaNetworkIndex,
                enclosingControl,
              },
              writes,
              reads,
              accessesTruncated,
              commentedOut,
              commentedSource: commentedLogic,
              partial: chunk.hasMore,
              logic: {
                text: chunk.text,
                offset: chunk.offset,
                totalChars: chunk.totalChars,
                hasMore: chunk.hasMore,
                nextOffset: chunk.nextOffset,
                maxChars,
              },
            },
            accessesTruncated ? [`Only the first ${HARD_ROWS} variable accesses are listed.`] : [],
          )
        },
        args.db_path,
      ),
    )
  },
})
}

// ----------------------------------------------------------- variable usage

const VARIABLE_TOOL = 'knowledge_variable_usage'

function variableTool(dependencies: DrilldownDependencies): ToolDefinition {
  return defineTool({
  name: VARIABLE_TOOL,
  description:
    'Find every place one variable is used, in a single call: the networks whose translated logic mentions it (the text ' +
    'is authoritative) plus the READS/WRITES graph edges, each labeled read, write or mention with its block and network ' +
    'index. Prefer it over chaining search + query + network for "where is X read/written" or "how is X processed" ' +
    'questions. Pass the full dotted path (for example \'Cav_A.Cavity.CAB\') or a leaf name; the leaf name also matches ' +
    'dotted paths that end in it. Fails with VARIABLE_NOT_FOUND when the database knows no such variable.',
  parameters: {
    variable: {
      type: 'string',
      required: true,
      description: "Full dotted variable path, or a leaf name such as 'btn_forward'.",
    },
    max_rows: {
      type: 'integer',
      description: 'Maximum usage rows to return (default 50, hard maximum 200).',
    },
    db_path: DB_PATH_PARAMETER,
  },
  output: {
    schema: localOutcomeSchema('Every usage site of one variable, labeled read / write / mention.'),
    render: (_args, value) => [{ type: 'text', text: renderLocalOutcome(value as unknown as LocalOutcome) }],
  },
  presentCall: (args) => ({ card: 'generic', title: `Usage of ${args.variable}`, kind: 'read', rawInput: args }),
  async execute(args, exec) {
    const tool = VARIABLE_TOOL
    const invalid = unusableValue(args.variable, 'Variable')
    if (invalid !== null) return asWireOutcome(refuse(tool, 'VARIABLE_INVALID', invalid, 'Pass the dotted path or the leaf name.'))

    return asWireOutcome(
      await body(
        tool,
        exec.agent?.session?.header?.cwd,
        async (dbPath) => {
          const limit = clampRows(args.max_rows)
          const nodeResult = await runQuery(dependencies, dbPath, variableNodesStatement(args.variable, 200), 200, exec.signal)
          if (refused(nodeResult)) return localFailure(tool, nodeResult.code, nodeResult.message, nodeResult.remediation)
          const nodeIds = nodeResult.rows.map((row) => textCell(row, 0)).filter((id): id is string => id !== null)
          if (nodeIds.length === 0) {
            return localFailure(
              tool,
              'VARIABLE_NOT_FOUND',
              `No variable named '${args.variable}' is in this database.`,
              'Call knowledge_search with the leaf name to find how the graph spells it, then retry.',
            )
          }

          const accessResult = await runQuery(
            dependencies,
            dbPath,
            variableAccessStatement(nodeIds, limit + 1),
            limit + 1,
            exec.signal,
          )
          if (refused(accessResult)) {
            return localFailure(tool, accessResult.code, accessResult.message, accessResult.remediation)
          }

          interface Site {
            networkId: string
            block: string
            index: number | null
            title: string | null
            sourceFile: string | null
            directions: Set<string>
          }
          const sites = new Map<string, Site>()
          for (const row of accessResult.rows) {
            const networkId = textCell(row, 0) ?? ''
            const direction = (textCell(row, 5) ?? '').toUpperCase() === 'WRITES' ? 'write' : 'read'
            const site = sites.get(networkId) ?? {
              networkId,
              block: textCell(row, 1) ?? '',
              index: intCell(row, 2),
              title: textCell(row, 3),
              sourceFile: textCell(row, 4),
              directions: new Set<string>(),
            }
            site.directions.add(direction)
            sites.set(networkId, site)
          }

          const mention = mentionStatement(args.variable, limit + 1)
          const mentionResult = await runQuery(dependencies, dbPath, mention.sql, limit + 1, exec.signal)
          let mentions = 0
          if (!refused(mentionResult)) {
            const mentionedIds = mentionResult.rows
              .map((row) => textCell(row, 0))
              .filter((id): id is string => id !== null)
            const unknown = mentionedIds.filter((id) => !sites.has(id))
            if (unknown.length > 0) {
              const named = await runQuery(
                dependencies,
                dbPath,
                networksByIdsStatement(unknown, unknown.length),
                unknown.length,
                exec.signal,
              )
              if (!refused(named)) {
                for (const row of named.rows) {
                  const networkId = textCell(row, 0) ?? ''
                  sites.set(networkId, {
                    networkId,
                    block: textCell(row, 1) ?? '',
                    index: intCell(row, 2),
                    title: textCell(row, 3),
                    sourceFile: textCell(row, 4),
                    directions: new Set<string>(),
                  })
                }
              }
            }
            mentions = mentionedIds.length
          }

          const usages: Array<{ block: string; index: number | null; title: string | null; sourceFile: string | null; access: string }> = []
          for (const site of [...sites.values()].sort((left, right) => {
            const byBlock = left.block.localeCompare(right.block, 'en')
            return byBlock !== 0 ? byBlock : (left.index ?? 0) - (right.index ?? 0)
          })) {
            const directions = site.directions.size === 0 ? ['mention'] : [...site.directions].sort()
            for (const direction of directions) {
              usages.push({ block: site.block, index: site.index, title: site.title, sourceFile: site.sourceFile, access: direction })
            }
          }
          const truncated = usages.length > limit
          const shown = truncated ? usages.slice(0, limit) : usages

          const details = [
            `Database: ${dbPath}`,
            `Variable: ${args.variable} — ${nodeIds.length} graph node(s), ${sites.size} network(s)`,
            `Usages: ${shown.length}${truncated ? ' (more than shown)' : ''}`,
          ]
          const fitted = fitDetails(
            shown.map((usage) => `- ${site(usage.block, usage.index, usage.access)}${usage.title === null ? '' : ` — ${usage.title}`}`),
            3500,
          )
          details.push(...fitted.lines)
          if (fitted.omitted > 0) details.push(`… ${fitted.omitted} more usage row(s) not shown; raise max_rows.`)
          if (truncated) {
            details.push(`The listing stopped at max_rows (${limit}); raise max_rows (hard maximum ${HARD_ROWS}).`)
          }
          if (mentions === 0) {
            details.push('No network text mentions this name; the read/write rows come from graph edges only.')
          }

          const warnings: string[] = []
          if (refused(mentionResult)) {
            warnings.push(`The mention scan failed (${mentionResult.code}: ${mentionResult.message}), so only edge-derived usages are listed.`)
          }
          if (!mention.fullText) {
            warnings.push('The name is shorter than 3 characters, so the mention scan used LIKE instead of the index.')
          }

          return localSuccess(
            tool,
            `${shown.length} usage(s) of '${args.variable}' across ${sites.size} network(s)${truncated ? ' (capped)' : ''}.`,
            details,
            {
              dbPath,
              variable: args.variable,
              matchedNodes: nodeIds,
              mentions,
              usages: shown,
              returned: shown.length,
              truncated,
            },
            warnings,
          )
        },
        args.db_path,
      ),
    )
  },
})
}

// ------------------------------------------------------------------ registry

/** One line for the model: newlines inside a snippet would break the listing. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** The names these tools register, in order; the registry and the tests share it. */
export const DRILLDOWN_TOOL_NAMES = [SEARCH_TOOL, BLOCK_TOOL, NETWORK_TOOL, VARIABLE_TOOL] as const

/** The subset `includeDrilldown: 'inspect'` registers: the two "what is in here" tools. */
export const INSPECT_TOOL_NAMES = [BLOCK_TOOL, NETWORK_TOOL] as const

/**
 * Every drill-down tool, in registration order, for the requested surface.
 *
 * `inspect` deliberately leaves `knowledge_search` and
 * `knowledge_variable_usage` out: they are the expert's investigation tools, and
 * the main agent's job with this surface is to read enough to brief a delegation
 * (docs/decisions.md D25).
 *
 * @param dependencies - the engine seam.
 * @param surface - `all` (default) or `inspect`.
 */
export function drilldownToolDefinitions(dependencies: DrilldownDependencies, surface: 'all' | 'inspect' = 'all'): ToolDefinition[] {
  const all = [searchTool(dependencies), blockTool(dependencies), networkTool(dependencies), variableTool(dependencies)]
  return surface === 'inspect' ? all.filter((tool) => (INSPECT_TOOL_NAMES as readonly string[]).includes(tool.name)) : all
}