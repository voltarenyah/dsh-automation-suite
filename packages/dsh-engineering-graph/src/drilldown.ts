/**
 * The drill-down layer: the SQL the four investigation tools send and the shape
 * they make of the rows that come back.
 *
 * Why these tools exist at all: the engine already materializes everything a
 * program-logic question needs — `knowledge_networks` (one row per network, with
 * the translated `logicStatements`), `knowledge_network_accesses` (which variable
 * each network reads or writes) and the FTS5 `knowledge_search` index — but no
 * tool exposed them (`docs/roadmap.md` §4 said exactly that). A model *can* write
 * that SQL itself; it costs several rounds, gets the escaping wrong and burns the
 * result budget finding out. These builders are the fixed, reviewed statements.
 *
 * Everything here is **pure**: SQL text in, row shapes out. Three properties are
 * deliberate:
 *
 *   1. **One `Query` per statement, no C# change.** D24 chose TypeScript-side SQL
 *      over new engine operations, because a new operation means touching the
 *      protocol whitelist, the engine and the tool surface, and rebuilding the
 *      shipped `engine/bin`.
 *   2. **Values are escaped, never interpolated raw.** `'` is doubled for string
 *      literals, `%`/`_`/`\` are escaped for `LIKE … ESCAPE '\'`, and FTS query
 *      text becomes a quoted literal. The engine refuses any statement containing
 *      an interior `;`, so a caller value that would smuggle one is rejected
 *      before the statement is built (`unusableValue`).
 *   3. **Bounds live in the SQL.** `substr(...)` and `LIMIT` keep the transfer and
 *      the render small; a `LIMIT n + 1` fetch is how truncation is detected here
 *      the same way the engine detects it.
 *
 * @module dsh-engineering-graph/drilldown
 */

/** Default rows a drill-down tool asks the engine for. */
export const DEFAULT_ROWS = 50

/** Hard cap on rows a drill-down tool asks for (the engine's own cap is 1000). */
export const HARD_ROWS = 200

/** Characters of a matched `logicStatements`/title kept as the search snippet. */
export const SNIPPET_CHARS = 240

/** Characters of one node property value rendered in `knowledge_block`. */
export const PROPERTY_CHARS = 200

/** Default characters of translated logic returned by `knowledge_network`. */
export const DEFAULT_LOGIC_CHARS = 3000

/**
 * Hard cap of translated logic characters per call.
 *
 * Deliberately below the framework's tool-result Pruner threshold (8192 chars,
 * which cuts the **middle** of an oversized result — exactly the code the model
 * asked for) and near the R1 budget of ~4 KB per result.
 */
export const HARD_LOGIC_CHARS = 6000

/** A value a caller supplied that cannot be put into a single statement. */
export function unusableValue(value: string, what: string): string | null {
  if (value.trim().length === 0) return `${what} must not be empty.`
  if (value.includes(';')) {
    return `${what} must not contain ';' — the engine accepts one statement per call and refuses the rest.`
  }
  if (value.includes('\u0000')) return `${what} must not contain a NUL character.`
  return null
}

/** A SQL string literal, with quotes doubled. */
export function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** A `LIKE` pattern body, escaping the three characters `ESCAPE '\'` protects. */
export function likeBody(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** An FTS5 query: the caller's text as one quoted literal (trigram = substring). */
export function ftsLiteral(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Whether a search should use the FTS index: the trigram tokenizer needs 3 characters. */
export function usesFullText(text: string): boolean {
  return text.trim().length >= 3
}

/** Clamps a requested row count into this module's range. */
export function clampRows(value: number | undefined, fallback = DEFAULT_ROWS): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), HARD_ROWS)
}

/** Clamps a requested logic-chunk size into this module's range. */
export function clampChars(value: number | undefined, fallback = DEFAULT_LOGIC_CHARS): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 200), HARD_LOGIC_CHARS)
}

// --------------------------------------------------------------------- search

/** The statement `knowledge_search` runs, and whether it used the FTS index. */
export interface SearchStatement {
  sql: string
  fullText: boolean
}

/**
 * Builds the search statement.
 *
 * Both branches return the same five columns in the same order — `node_id`,
 * `kind`, `name`, `field`, `snippet` — so one shape function reads either.
 *
 * @param text - what to look for.
 * @param kind - optional node-kind filter (e.g. `'Network'`).
 * @param limit - rows to fetch; the caller adds one to detect truncation.
 */
export function searchStatement(text: string, kind: string | undefined, limit: number): SearchStatement {
  const kindFilter = kind === undefined || kind.trim().length === 0 ? '' : ` AND kind = ${sqlText(kind.trim())}`
  if (usesFullText(text)) {
    return {
      fullText: true,
      sql:
        'SELECT s.node_id, s.kind, n.name, s.field, substr(s.content, 1, ' +
        `${SNIPPET_CHARS})\nFROM knowledge_search s JOIN graph_nodes n ON n.id = s.node_id\n` +
        `WHERE knowledge_search MATCH ${ftsLiteral(text.trim())}\n` +
        `  AND s.field IN ('name', 'title', 'logicStatements')${kindFilter}\n` +
        'ORDER BY s.kind, s.node_id, s.field\n' +
        `LIMIT ${limit}`,
    }
  }

  const pattern = sqlText(`%${likeBody(text)}%`)
  const nodeKind = kind === undefined || kind.trim().length === 0 ? '' : ` AND kind = ${sqlText(kind.trim())}`
  const propertyKind = nodeKind.replace(' kind = ', ' n.kind = ')
  return {
    fullText: false,
    sql:
      `SELECT id, kind, name, 'name', NULL\nFROM graph_nodes\nWHERE name LIKE ${pattern} ESCAPE '\\'${nodeKind}\n` +
      'UNION ALL\n' +
      'SELECT n.id, n.kind, n.name, p.name, substr(p.value, 1, ' +
      `${SNIPPET_CHARS})\nFROM graph_nodes n JOIN graph_node_properties p ON p.node_id = n.id\n` +
      `  AND p.name IN ('title', 'logicStatements')\nWHERE p.value LIKE ${pattern} ESCAPE '\\'${propertyKind}\n` +
      `ORDER BY 2, 1, 4\nLIMIT ${limit}`,
  }
}

/** One search match, as the model reads it. */
export interface SearchMatch {
  nodeId: string
  kind: string
  name: string
  field: string
  snippet: string | null
}

// ---------------------------------------------------------------------- block

/** The statement that resolves a block name to its node. */
export function blockStatement(block: string): string {
  return (
    "SELECT id, kind, name FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')\n" +
    `  AND name = ${sqlText(block)} COLLATE NOCASE\nORDER BY id\nLIMIT 5`
  )
}

/** The statement that reads one node's properties, values already bounded. */
export function blockPropertiesStatement(nodeId: string, limit: number): string {
  return (
    `SELECT name, substr(value, 1, ${PROPERTY_CHARS}) FROM graph_node_properties\n` +
    `WHERE node_id = ${sqlText(nodeId)}\nORDER BY name\nLIMIT ${limit}`
  )
}

/** The statement that lists a block's networks, compactly. */
export function blockNetworksStatement(nodeId: string, limit: number): string {
  return (
    'SELECT network_index, network_id, title, language, coalesce(length(logic_statements), 0), source_file,\n' +
    "  (SELECT value FROM graph_node_properties p WHERE p.node_id = knowledge_networks.network_id\n" +
    "     AND p.name = 'logicCommented') AS commented\n" +
    `FROM knowledge_networks\nWHERE block_id = ${sqlText(nodeId)}\n` +
    `ORDER BY network_index\nLIMIT ${limit}`
  )
}

/** One compact network row of `knowledge_block`. */
export interface NetworkSummary {
  index: number | null
  networkId: string
  title: string | null
  language: string | null
  logicChars: number
  sourceFile: string | null
  /** True when the network's whole source is commented out, so it has no executable logic. */
  commented: boolean
}

// -------------------------------------------------------------------- network

/** The statement that reads exactly one network, logic included. */
export function networkStatement(blockId: string, networkIndex: number): string {
  return (
    'SELECT network_id, title, language, compile_unit_id, source_file, logic_statements,\n' +
    "  (SELECT value FROM graph_node_properties p WHERE p.node_id = knowledge_networks.network_id\n" +
    "     AND p.name = 'commentedLogic') AS commented_logic,\n" +
    "  (SELECT value FROM graph_node_properties p WHERE p.node_id = knowledge_networks.network_id\n" +
    "     AND p.name = 'logicCommented') AS commented\n" +
    `FROM knowledge_networks\nWHERE block_id = ${sqlText(blockId)} AND network_index = ${Math.trunc(networkIndex)}\n` +
    'LIMIT 1'
  )
}

/** The statement that reads one network's variable accesses. */
export function networkAccessStatement(networkId: string, limit: number): string {
  return (
    'SELECT access, variable_name FROM knowledge_network_accesses\n' +
    `WHERE network_id = ${sqlText(networkId)}\nORDER BY access, variable_name\nLIMIT ${limit}`
  )
}

/** One network access, split by direction by the caller. */
export interface AccessRecord {
  access: string
  variable: string
}

// ----------------------------------------------------------- variable usage

/** The statement that resolves a variable name to its graph nodes. */
export function variableNodesStatement(variable: string, limit: number): string {
  const suffix = sqlText(`%.${likeBody(variable)}`)
  return (
    "SELECT id, name FROM graph_nodes\nWHERE kind = 'Variable'\n" +
    `  AND (name = ${sqlText(variable)} COLLATE NOCASE OR name LIKE ${suffix} ESCAPE '\\')\n` +
    `ORDER BY id\nLIMIT ${limit}`
  )
}

/** The statement that reads every READS/WRITES site of the given variable nodes. */
export function variableAccessStatement(nodeIds: readonly string[], limit: number): string {
  const ids = nodeIds.map(sqlText).join(', ')
  return (
    'SELECT a.network_id, w.block_id, w.network_index, w.title, w.source_file, a.access, a.variable_name\n' +
    'FROM knowledge_network_accesses a JOIN knowledge_networks w ON w.network_id = a.network_id\n' +
    `WHERE a.target_node_id IN (${ids})\n` +
    `ORDER BY w.block_id, w.network_index, a.access, a.variable_name\nLIMIT ${limit}`
  )
}

/** The statement that finds the networks whose translated logic mentions the text. */
export function mentionStatement(text: string, limit: number): SearchStatement {
  if (usesFullText(text)) {
    return {
      fullText: true,
      sql:
        'SELECT node_id FROM knowledge_search\n' +
        `WHERE knowledge_search MATCH ${ftsLiteral(text.trim())}\n` +
        "  AND kind = 'Network' AND field = 'logicStatements'\n" +
        `LIMIT ${limit}`,
    }
  }
  return {
    fullText: false,
    sql:
      'SELECT n.id FROM graph_nodes n JOIN graph_node_properties p ON p.node_id = n.id\n' +
      "  AND p.name = 'logicStatements'\n" +
      `WHERE n.kind = 'Network' AND p.value LIKE ${sqlText(`%${likeBody(text)}%`)} ESCAPE '\\'\n` +
      `LIMIT ${limit}`,
  }
}

/** The statement that names the block and index of the given networks. */
export function networksByIdsStatement(networkIds: readonly string[], limit: number): string {
  const ids = networkIds.map(sqlText).join(', ')
  return (
    'SELECT network_id, block_id, network_index, title, source_file FROM knowledge_networks\n' +
    `WHERE network_id IN (${ids})\nORDER BY block_id, network_index\nLIMIT ${limit}`
  )
}

/** One variable-usage site, direction included (`read` / `write` / `mention`). */
export interface UsageRow {
  block: string
  blockKind: string | null
  networkIndex: number | null
  networkTitle: string | null
  sourceFile: string | null
  access: string
  variable: string | null
}

// ------------------------------------------------------------------ row reads

/** Reads a text cell, or `null` when the value is not a string. */
export function textCell(row: readonly unknown[], index: number): string | null {
  const value = row[index]
  return typeof value === 'string' ? value : null
}

/** Reads an integer cell, or `null` when the value is not a finite number. */
export function intCell(row: readonly unknown[], index: number): number | null {
  const value = row[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Maps engine rows through a reader, dropping nothing. */
export function mapRows<T>(rows: readonly (readonly unknown[])[], read: (row: readonly unknown[]) => T): T[] {
  return rows.map(read)
}

// ----------------------------------------------------------------- logic chunks

/** One slice of a network's translated logic. */
export interface LogicChunk {
  text: string
  /** The offset this slice started at. */
  offset: number
  /** Characters in the whole `logicStatements` value. */
  totalChars: number
  hasMore: boolean
  /** The offset to pass next, or `null` when this slice ends the text. */
  nextOffset: number | null
}

/**
 * Slices translated logic for one call.
 *
 * `offset` past the end yields an empty slice with `hasMore: false` rather than an
 * error: a model that over-pages deserves an empty answer, not a failure it has
 * to interpret.
 *
 * @param logic - the whole `logicStatements` value, or `null` when there is none.
 * @param offset - zero-based character offset.
 * @param maxChars - slice size, already clamped by the caller.
 */
export function chunkLogic(logic: string | null, offset: number, maxChars: number): LogicChunk {
  const text = logic ?? ''
  const start = Math.min(Math.max(Math.trunc(offset), 0), text.length)
  const slice = text.slice(start, start + maxChars)
  const end = start + slice.length
  const hasMore = end < text.length
  return {
    text: slice,
    offset: start,
    totalChars: text.length,
    hasMore,
    nextOffset: hasMore ? end : null,
  }
}

// ------------------------------------------------------------------ rendering

/** A bounded detail list: what fit, and how many entries did not. */
export interface FittedDetails {
  lines: string[]
  omitted: number
}

/**
 * Keeps detail lines while they fit a character budget.
 *
 * The framework prunes an oversized tool result by cutting its **middle**
 * (`thresholdChars: 8192`), which loses exactly the rows in the middle of a
 * listing, so a tool that renders its own bounded listing is strictly better off
 * than one that lets the Pruner decide.
 *
 * @param lines - the candidate lines, already formatted.
 * @param budget - total characters to spend on them.
 * @param reserveForOmitted - characters kept free for the "… N more" line.
 */
export function fitDetails(lines: readonly string[], budget: number, reserveForOmitted = 120): FittedDetails {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (used + cost > budget - reserveForOmitted) return { lines: kept, omitted: lines.length - kept.length }
    kept.push(line)
    used += cost
  }
  return { lines: kept, omitted: 0 }
}

/** Formats a byte/character count for a line a model reads. */
export function renderCount(value: number): string {
  return value.toLocaleString('en-US')
}
