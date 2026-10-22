/**
 * The drill-down layer: the fixed statements, their escaping, the row shapes and
 * the bounded render.
 *
 * Two kinds of test live here on purpose:
 *
 *   1. **Pure builders** (`src/drilldown.ts`), asserted as text: escaping, the
 *      FTS/LIKE switch, the `LIMIT n + 1` truncation probe and the clamps are the
 *      parts that silently produce a wrong answer rather than an error.
 *   2. **Tool bodies** against a recording engine stub, so what the model would
 *      actually read is asserted: the summary, the bounded details and the fact
 *      that a refusal never reaches the engine.
 *
 * @module dsh-engineering-graph/test/drilldown
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestContext, executeTool, loadToolsModule, renderedText } from './helpers/harness.mjs'

const tools = await loadToolsModule()
const drilldown = await import(new URL('../lib/drilldown.js', import.meta.url).href)

/** The four drill-down names, in the order the row registers them. */
const DRILLDOWN_NAMES = ['knowledge_search', 'knowledge_block', 'knowledge_network', 'knowledge_variable_usage']


/** An explicit database path: the drill-down tools' own resolution is covered elsewhere. */
const DB = 'C:\\ws\\knowledge\\PLC_1\\PLC_1_knowledge.db'

const NO_SIGNAL = { signal: new AbortController().signal }
const execIn = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })

/** A successful engine frame carrying `data`. */
function frame(data) {
  return { type: 'result', protocol: 1, id: 'stub', operation: 'Query', ok: true, durationMs: 2, data }
}

/** A refused engine frame. */
function refusal(code, message, remediation) {
  return {
    type: 'result',
    protocol: 1,
    id: 'stub',
    operation: 'Query',
    ok: false,
    durationMs: 1,
    error: { code, message, ...(remediation === undefined ? {} : { remediation }) },
  }
}

/** Rows in the engine's wire shape: an array per row, plus column names. */
function rowsPayload(columns, rows) {
  return { dbPath: 'C:\\ws\\knowledge\\PLC_1\\PLC_1_knowledge.db', columns, rows, rowCount: rows.length, truncated: false }
}

/**
 * Registers the tools with the drill-down surface on, driven by `respond`.
 *
 * @param {(sql: string) => object} respond - maps one statement to a frame.
 */
async function harness(respond) {
  const context = createTestContext()
  const calls = []
  tools.registerTools(
    context.ctx,
    {
      request: async (operation, params) => {
        calls.push({ operation, params })
        return respond(params.sql)
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    },
    { includeIngest: true, includeDrilldown: true },
  )
  const byName = Object.fromEntries(context.definitions.map((definition) => [definition.name, definition]))
  return { context, calls, byName }
}

// ------------------------------------------------------------------ builders

test('escaping: quotes, LIKE wildcards and FTS literals', () => {
  assert.equal(drilldown.sqlText("O'Brien"), "'O''Brien'")
  assert.equal(drilldown.likeBody('100%_x\\y'), '100\\%\\_x\\\\y')
  assert.equal(drilldown.ftsLiteral('say "hi"'), '"say ""hi"""')
})

test('a value that would smuggle a second statement is refused before the SQL is built', () => {
  assert.equal(drilldown.unusableValue('Main', 'Block name'), null)
  assert.match(drilldown.unusableValue('', 'Block name'), /must not be empty/)
  assert.match(drilldown.unusableValue('Main; DROP TABLE graph_nodes', 'Block name'), /must not contain ';'/)
})

test('search uses the index for 3+ characters and a LIKE scan below that', () => {
  const long = drilldown.searchStatement('Cylinder', undefined, 51)
  assert.equal(long.fullText, true)
  assert.match(long.sql, /FROM knowledge_search s JOIN graph_nodes n/)
  assert.match(long.sql, /MATCH "Cylinder"/)
  assert.match(long.sql, /LIMIT 51$/)

  const short = drilldown.searchStatement('ab', 'Network', 11)
  assert.equal(short.fullText, false)
  assert.match(short.sql, /UNION ALL/)
  assert.match(short.sql, /LIKE '%ab%' ESCAPE '\\'/)
  assert.match(short.sql, /AND kind = 'Network'/)
  assert.match(short.sql, /AND n\.kind = 'Network'/, 'the filter must apply to both branches of the union')
})

test('row and chunk sizes are clamped, and chunking reports how to continue', () => {
  assert.equal(drilldown.clampRows(undefined), 50)
  assert.equal(drilldown.clampRows(0), 1)
  assert.equal(drilldown.clampRows(9999), 200)
  assert.equal(drilldown.clampChars(undefined), 3000)
  assert.equal(drilldown.clampChars(1), 200, 'a floor keeps a page worth a call')
  assert.equal(drilldown.clampChars(99999), 6000)

  const chunk = drilldown.chunkLogic('abcdefghij', 4, 3)
  assert.deepEqual(chunk, { text: 'efg', offset: 4, totalChars: 10, hasMore: true, nextOffset: 7 })

  const tail = drilldown.chunkLogic('abcdefghij', 8, 3)
  assert.deepEqual(tail, { text: 'ij', offset: 8, totalChars: 10, hasMore: false, nextOffset: null })

  assert.equal(drilldown.chunkLogic(null, 0, 10).totalChars, 0)
  assert.equal(drilldown.chunkLogic('abc', 99, 10).text, '', 'over-paging answers empty, not with an error')
})

test('the detail budget keeps what fits and counts what it left out', () => {
  const fitted = drilldown.fitDetails(['x'.repeat(50), 'y'.repeat(50), 'z'.repeat(50)], 200, 120)
  assert.equal(fitted.lines.length, 1)
  assert.equal(fitted.omitted, 2)

  const everything = drilldown.fitDetails(['short', 'lines'], 200, 120)
  assert.equal(everything.omitted, 0)
})

// -------------------------------------------------------------------- search

test('knowledge_search shapes matches, reports truncation and warns about a short scan', async () => {
  const { byName, calls } = await harness(() =>
    frame(rowsPayload(['node_id', 'kind', 'name', 'field', 'snippet'], [
      ['network:C1', 'Network', 'Cylinder moves', 'title', 'Cylinder moves forward'],
      ['block:Main', 'OB', 'Main', 'name', null],
    ])),
  )

  const outcome = await executeTool(byName['knowledge_search'], { text: 'Cylinder', max_rows: 10, db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.tool, 'knowledge_search')
  assert.equal(calls.length, 1)
  assert.match(calls[0].params.sql, /LIMIT 11/, 'one extra row is fetched so truncation is provable')
  assert.equal(calls[0].params.maxRows, 11)
  assert.deepEqual(outcome.data.matches[0], {
    nodeId: 'network:C1',
    kind: 'Network',
    name: 'Cylinder moves',
    field: 'title',
    snippet: 'Cylinder moves forward',
  })
  assert.match(outcome.details.join('\n'), /\[Network\] Cylinder moves \(title\)/)
  assert.deepEqual(outcome.warnings, [])
})

test('knowledge_search says it capped the listing instead of pointing at data', async () => {
  const rows = Array.from({ length: 4 }, (_value, index) => [`n:${index}`, 'FB', `Block${index}`, 'name', null])
  const { byName } = await harness(() => frame(rowsPayload(['node_id', 'kind', 'name', 'field', 'snippet'], rows)))

  const outcome = await executeTool(byName['knowledge_search'], { text: 'Block', max_rows: 2, db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.data.returned, 2)
  assert.equal(outcome.data.truncated, true)
  const details = outcome.details.join('\n')
  assert.match(details, /stopped at max_rows \(2\)/)
  assert.ok(!details.includes('data.rows'), 'the model cannot read data, so nothing may point there')
})

test('knowledge_search falls back to LIKE for 1-2 characters and says so', async () => {
  const { byName, calls } = await harness(() =>
    frame(rowsPayload(['node_id', 'kind', 'name', 'field', 'snippet'], [['v:1', 'Variable', 'ab', 'name', null]])),
  )

  const outcome = await executeTool(byName['knowledge_search'], { text: 'ab', db_path: DB }, execIn('C:\\ws'))
  assert.match(calls[0].params.sql, /UNION ALL/)
  assert.equal(outcome.data.fullText, false)
  assert.match(outcome.warnings.join('\n'), /shorter than 3 characters/)
})

test('knowledge_search refuses an unusable text without touching the engine', async () => {
  const { byName, calls } = await harness(() => frame(rowsPayload([], [])))
  const outcome = await executeTool(byName['knowledge_search'], { text: 'x; DROP TABLE graph_nodes', db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'SEARCH_TEXT_INVALID')
  assert.deepEqual(calls, [])
})

// --------------------------------------------------------------------- block

test('knowledge_block names a missing block and suggests the search tool', async () => {
  const { byName } = await harness(() => frame(rowsPayload(['id', 'kind', 'name'], [])))
  const outcome = await executeTool(byName['knowledge_block'], { block: 'NoSuchBlock', db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'BLOCK_NOT_FOUND')
  assert.match(outcome.error.remediation, /knowledge_search/)
})

test('knowledge_block reports the block, its properties and its networks compactly', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'FB', 'Main']]))
    }
    if (sql.includes('FROM knowledge_networks')) {
      return frame(
        rowsPayload(
          ['network_index', 'network_id', 'title', 'language', 'coalesce(length(logic_statements), 0)', 'source_file', 'commented'],
          [
            [1, 'network:Main:1', 'Start', 'LAD', 120, 'Blocks/Main [OB1].xml', null],
            [2, 'network:Main:2', null, 'LAD', 40, 'Blocks/Main [OB1].xml', null],
          ],
        ),
      )
    }
    return frame(rowsPayload(['name', 'value'], [['language', 'LAD'], ['sourceFile', 'Blocks/Main [OB1].xml']]))
  })

  const outcome = await executeTool(byName['knowledge_block'], { block: 'Main', db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.block.id, 'block:Main')
  assert.equal(outcome.data.networks.length, 2)
  const details = outcome.details.join('\n')
  assert.match(details, /Block: Main \(FB\) — block:Main/)
  assert.match(details, /Source file: Blocks\/Main \[OB1\]\.xml/)
  assert.match(details, /Properties: language=LAD; sourceFile=Blocks\/Main \[OB1\]\.xml/)
  assert.match(details, /- \[1\] Start \(LAD\), 120 logic char\(s\)/)
  assert.match(details, /Next step: knowledge_network/)
})

// ------------------------------------------------------------------- network

test('knowledge_block lists SCL regions and their kinds', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:LAxisCtrl_Axis', 'FB', 'LAxisCtrl_Axis']]))
    }
    if (sql.includes('FROM knowledge_networks')) {
      return frame(
        rowsPayload(
          [
            'network_index',
            'network_id',
            'title',
            'language',
            'coalesce(length(logic_statements), 0)',
            'source_file',
            'commented',
            'region_path',
            'segment_kind',
            'total',
            'commented_total',
          ],
          [
            [1, 'network:LAxisCtrl_Axis:1', 'HEADER', 'SCL', 0, 'Blocks/LAxisCtrl_Axis.xml', 'true', 'HEADER', 'region', 13, 2],
            [2, 'network:LAxisCtrl_Axis:2', 'ENABLE_FB / FB_ENABLED', 'SCL', 6766, null, null, 'ENABLE_FB / FB_ENABLED', 'region', 13, 2],
            [3, 'network:LAxisCtrl_Axis:3', 'ENABLE_FB / RUN (part 1/2)', 'SCL', 5999, null, null, 'ENABLE_FB / RUN', 'part', 13, 2],
          ],
        ),
      )
    }
    return frame(rowsPayload(['name', 'value'], [['language', 'SCL']]))
  })

  const outcome = await executeTool(byName['knowledge_block'], { block: 'LAxisCtrl_Axis', db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, true)
  const details = outcome.details.join('\n')
  assert.match(details, /- \[1\] HEADER \(SCL region\), 0 logic char\(s\), COMMENTED OUT/)
  assert.match(details, /- \[2\] ENABLE_FB \/ FB_ENABLED \(SCL region\), 6,766 logic char\(s\)/)
  assert.match(details, /- \[3\] ENABLE_FB \/ RUN \(part 1\/2\) \(SCL part\), 5,999 logic char\(s\)/)
  assert.match(details, /SCL segmentation: each row is one REGION/)
  assert.equal(outcome.data.networks[1].regionPath, 'ENABLE_FB / FB_ENABLED')
  assert.equal(outcome.data.networks[1].segmentKind, 'region')
  assert.equal(outcome.data.total, 13, 'the total still comes from the statement')
})

// ------------------------------------------------------------------- network

test('knowledge_network splits reads from writes and chunks the logic', async () => {
  const logic = 'x'.repeat(250)
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'OB', 'Main']]))
    }
    if (sql.includes('AND network_index = 3')) {
      return frame(
        rowsPayload(['network_id', 'title', 'language', 'compile_unit_id', 'source_file', 'logic_statements'], [
          ['network:Main:3', 'Fill', 'LAD', 'cu:3', 'Blocks/Main [OB1].xml', logic],
        ]),
      )
    }
    return frame(
      rowsPayload(['access', 'variable_name'], [
        ['READS', 'btn_start'],
        ['WRITES', 'Cavity.fill'],
        ['WRITES', 'Cavity.done'],
      ]),
    )
  })

  const outcome = await executeTool(
    byName['knowledge_network'],
    { block: 'Main', index: 3, max_chars: 100, db_path: DB },
    execIn('C:\\ws'),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.data.writes, ['Cavity.fill', 'Cavity.done'])
  assert.deepEqual(outcome.data.reads, ['btn_start'])
  assert.equal(outcome.data.logic.text.length, 200, 'max_chars below the floor is raised to it')
  assert.equal(outcome.data.logic.totalChars, 250)
  assert.equal(outcome.data.logic.hasMore, true)
  assert.equal(outcome.data.logic.nextOffset, 200)
  const details = outcome.details.join('\n')
  assert.match(details, /Writes \(2\): Cavity\.fill, Cavity\.done/)
  assert.match(details, /Logic: characters 0–200 of 250/)
  assert.match(details, /NEXT: knowledge_network\(block="Main", index=3, offset=200, max_chars=200\)/)
  assert.match(outcome.summary, /PARTIAL 0–200 of 250/)
  assert.equal(outcome.data.partial, true)
})

test('knowledge_network bounds a long read/write list so the header lines survive', async () => {
  const writes = Array.from({ length: 40 }, (_, index) => `out_${index}`)
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Big', 'FB', 'Big']]))
    }
    if (sql.includes('AND network_index = 2')) {
      return frame(
        rowsPayload(['network_id', 'title', 'language', 'compile_unit_id', 'source_file', 'logic_statements'], [
          ['network:Big:2', 'ENABLE_FB', 'SCL', 'cu:2', null, 'x'.repeat(120)],
        ]),
      )
    }
    return frame(
      rowsPayload(
        ['access', 'variable_name'],
        [
          ...writes.map((name) => ['WRITES', name]),
          ['READS', 'a'], ['READS', 'b'], ['READS', 'c'],
        ],
      ),
    )
  })

  const outcome = await executeTool(byName['knowledge_network'], { block: 'Big', index: 2, db_path: DB }, execIn('C:\\ws'))

  const details = outcome.details.join('\n')
  assert.match(details, /Writes \(40\): out_0, out_1, out_2, .*… \(\+28 more\)/)
  assert.match(details, /Reads \(3\): a, b, c/)
  // The regression this guards: an unbounded Writes line pushed `Logic:` out of the
  // auxiliary budget, so the model never learned the character range it was reading.
  assert.match(details, /Logic: characters 0–120 of 120/)
})

test('knowledge_network reads a later chunk and stops saying there is more', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'OB', 'Main']]))
    }
    if (sql.includes('AND network_index = 1')) {
      return frame(rowsPayload(['network_id', 'title', 'language', 'compile_unit_id', 'source_file', 'logic_statements'], [
        ['network:Main:1', null, 'SCL', null, null, 'abcdefghij'],
      ]))
    }
    return frame(rowsPayload(['access', 'variable_name'], []))
  })

  const outcome = await executeTool(
    byName['knowledge_network'],
    { block: 'Main', index: 1, offset: 8, max_chars: 100, db_path: DB },
    execIn('C:\\ws'),
  )

  assert.equal(outcome.data.logic.text, 'ij')
  assert.equal(outcome.data.logic.hasMore, false)
  assert.ok(!outcome.details.join('\n').includes('again with offset='), 'the last chunk must not ask for another')
})

test('knowledge_network names the SCL region, its TIA network and the enclosing control', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:LAxisCtrl_Axis', 'FB', 'LAxisCtrl_Axis']]))
    }
    if (sql.includes('AND network_index = 7')) {
      return frame(
        rowsPayload(
          [
            'network_id',
            'title',
            'language',
            'compile_unit_id',
            'source_file',
            'logic_statements',
            'commented_logic',
            'commented',
            'region_path',
            'segment_kind',
            'tia_network_index',
            'enclosing_control',
          ],
          [
            [
              'network:LAxisCtrl_Axis:7',
              'ENABLE_FB / FB_ENABLED',
              'SCL',
              '45A',
              'Blocks/LAxisCtrl_Axis.xml',
              'tempEnable := enable;',
              null,
              null,
              'ENABLE_FB / FB_ENABLED',
              'region',
              1,
              'IF NOT tempEnable AND statEnableOld THEN',
            ],
          ],
        ),
      )
    }
    return frame(rowsPayload(['access', 'variable_name'], []))
  })

  const outcome = await executeTool(
    byName['knowledge_network'],
    { block: 'LAxisCtrl_Axis', index: 7, db_path: DB },
    execIn('C:\\ws'),
  )

  assert.equal(outcome.ok, true)
  const details = outcome.details.join('\n')
  assert.match(details, /Region: ENABLE_FB \/ FB_ENABLED/)
  assert.match(details, /Context: inside IF NOT tempEnable AND statEnableOld THEN/)
  assert.match(details, /TIA network: 1/)
  assert.match(outcome.summary, /LAxisCtrl_Axis\[7\] ENABLE_FB \/ FB_ENABLED: 0 write\(s\), 0 read\(s\)/)
  assert.equal(outcome.data.network.segmentKind, 'region')
  assert.equal(outcome.data.network.tiaNetworkIndex, 1)
})

test('knowledge_network rejects a missing network and a nonsensical index', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'OB', 'Main']]))
    }
    return frame(rowsPayload(['network_id'], []))
  })

  const missing = await executeTool(byName['knowledge_network'], { block: 'Main', index: 9, db_path: DB }, execIn('C:\\ws'))
  assert.equal(missing.error.code, 'NETWORK_NOT_FOUND')
  assert.match(missing.error.remediation, /knowledge_block/)

  const invalid = await executeTool(byName['knowledge_network'], { block: 'Main', index: 0, db_path: DB }, execIn('C:\\ws'))
  assert.equal(invalid.error.code, 'NETWORK_INDEX_INVALID')
})

// ----------------------------------------------------------- variable usage

test('knowledge_variable_usage merges edge sites with text mentions', async () => {
  const { byName, calls } = await harness((sql) => {
    if (sql.includes("kind = 'Variable'")) {
      return frame(rowsPayload(['id', 'name'], [['variable:Cav_A.Cavity', 'Cav_A.Cavity']]))
    }
    if (sql.includes('FROM knowledge_network_accesses a JOIN knowledge_networks w')) {
      return frame(
        rowsPayload(
          ['network_id', 'block_id', 'network_index', 'title', 'source_file', 'access', 'variable_name'],
          [['network:PLC_1:2', 'block:FC_1', 2, 'Fill', 'Blocks/FC_1.xml', 'WRITES', 'Cav_A.Cavity']],
        ),
      )
    }
    if (sql.includes("kind = 'Network' AND field = 'logicStatements'")) {
      return frame(rowsPayload(['node_id'], [['network:PLC_2:7']]))
    }
    return frame(
      rowsPayload(['network_id', 'block_id', 'network_index', 'title', 'source_file'], [
        ['network:PLC_2:7', 'block:FC_2', 7, 'Drain', 'Blocks/FC_2.xml'],
      ]),
    )
  })

  const outcome = await executeTool(byName['knowledge_variable_usage'], { variable: 'Cav_A.Cavity', db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.mentions, 1)
  assert.deepEqual(
    outcome.data.usages.map((usage) => `${usage.block}[${usage.index}] ${usage.access}`),
    ['block:FC_1[2] write', 'block:FC_2[7] mention'],
  )
  assert.match(outcome.details.join('\n'), /- block:FC_1\[2\] write — Fill/)
  assert.ok(calls.length >= 4, 'nodes, edges, mentions and the mention names are separate statements')
})

test('knowledge_variable_usage names an unknown variable instead of guessing', async () => {
  const { byName } = await harness(() => frame(rowsPayload(['id', 'name'], [])))
  const outcome = await executeTool(byName['knowledge_variable_usage'], { variable: 'nope', db_path: DB }, execIn('C:\\ws'))
  assert.equal(outcome.error.code, 'VARIABLE_NOT_FOUND')
  assert.match(outcome.error.remediation, /knowledge_search/)
})

// --------------------------------------------------------------- resolution

test('a drill-down tool resolves the workspace database exactly like knowledge_query', async () => {
  const { byName, calls } = await harness(() => frame(rowsPayload([], [])))
  const outcome = await executeTool(byName['knowledge_search'], { text: 'anything' }, NO_SIGNAL)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'WORKSPACE_UNAVAILABLE')
  assert.equal(outcome.tool, 'knowledge_search', 'the refusal must name the tool the model called')
  assert.deepEqual(calls, [], 'nothing may reach the engine without a database')
})

// --------------------------------------------------------------- registration

test('the drill-down tools are opt-in and follow the four shared tools', async () => {
  const context = createTestContext()
  const dependencies = {
    request: async () => frame(rowsPayload([], [])),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }

  const without = createTestContext()
  tools.registerTools(without.ctx, dependencies)
  assert.deepEqual(without.registered(), ['knowledge_workspace', 'knowledge_schema', 'knowledge_ingest', 'knowledge_query'])

  tools.registerTools(context.ctx, dependencies, { includeDrilldown: true })
  assert.deepEqual(context.registered(), [
    'knowledge_workspace',
    'knowledge_schema',
    'knowledge_ingest',
    'knowledge_query',
    ...DRILLDOWN_NAMES,
  ])

  for (const name of DRILLDOWN_NAMES) {
    const definition = context.definitions.find((candidate) => candidate.name === name)
    assert.ok(definition.description.length > 80, `${name} needs a description a model can choose on`)
    assert.equal(definition.output.schema.properties.tool.type, 'string')
    assert.deepEqual(
      [...definition.output.schema.required].sort(),
      ['details', 'ok', 'summary', 'tool', 'warnings'],
      `${name} declares the local envelope, not an engine operation it did not run alone`,
    )
  }
})

test('the tools-entry row passes includeDrilldown through to the registry', async () => {
  const entry = await import(new URL('../lib/tools-entry.js', import.meta.url).href)
  const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

  const context = createTestContext()
  plugin.apply(context.ctx, { enginePath: 'C:\\does\\not\\exist\\EngineeringGraph.Engine.exe' })
  entry.apply(context.ctx, { includeIngest: false, includeDrilldown: true })

  assert.deepEqual(context.registered(), ['knowledge_workspace', 'knowledge_schema', 'knowledge_query', ...DRILLDOWN_NAMES])
})

// --------------------------------------------------------- the query budget

test('knowledge_query renders a bounded slice, never pointing at data the model cannot read', async () => {
  const long = 'L'.repeat(900)
  const rows = Array.from({ length: 60 }, (_value, index) => [index, `Block${index}`, long])
  const context = createTestContext()
  tools.registerTools(context.ctx, {
    request: async (_operation, params) =>
      frame({
        dbPath: params.dbPath,
        columns: ['n', 'name', 'logic'],
        rows,
        rowCount: rows.length,
        truncated: false,
      }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_query')
  const args = { sql: 'SELECT n, name, logic FROM knowledge_networks', db_path: DB }
  const outcome = await executeTool(definition, args, execIn('C:\\ws'))
  const rendered = renderedText(definition, args, outcome)

  assert.match(rendered, /Rows: 60/)
  assert.match(rendered, /more row\(s\) not shown .*LIMIT and OFFSET/s)
  assert.match(rendered, /cut at 200 characters/)
  assert.ok(!rendered.includes('data.rows'), 'the model cannot read data, so nothing may point there')
  assert.ok(rendered.length < 6000, `the render must stay under the Pruner threshold, was ${rendered.length} characters`)
  assert.match(rendered, /\{"n":0,"name":"Block0","logic":"L{200}/, 'rows render as column-named JSON objects')
})

// ------------------------------------------------ commented-out networks

test('knowledge_network says a fully commented-out network has no executable logic', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'FB', 'Main']]))
    }
    if (sql.includes('AND network_index = 32')) {
      return frame(
        rowsPayload(
          ['network_id', 'title', 'language', 'compile_unit_id', 'source_file', 'logic_statements', 'commented_logic', 'commented'],
          [
            [
              'network:Main:32',
              'Step[8] move data',
              'SCL',
              'cu:32',
              null,
              null,
              '// IF #G.%X8 THEN\n// #statProductData[1] := #statProductData[0];',
              'true',
            ],
          ],
        ),
      )
    }
    return frame(rowsPayload(['access', 'variable_name'], []))
  })

  const outcome = await executeTool(byName['knowledge_network'], { block: 'Main', index: 32, db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.commentedOut, true)
  assert.equal(outcome.data.logic.text, '')
  const details = outcome.details.join('\n')
  assert.match(outcome.summary, /no executable logic — the source is commented out/)
  assert.match(details, /Executable logic: NONE/)
  assert.match(details, /Commented-out source \(kept for review, NOT executed\)/)
  assert.match(details, /\/\/ #statProductData\[1\]/)
})

test('knowledge_block marks commented-out networks in its list', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'FB', 'Main']]))
    }
    if (sql.includes('FROM knowledge_networks')) {
      return frame(
        rowsPayload(
          ['network_index', 'network_id', 'title', 'language', 'coalesce(length(logic_statements), 0)', 'source_file', 'commented'],
          [
            [31, 'network:Main:31', 'Normal', 'SCL', 120, null, null],
            [32, 'network:Main:32', 'Step[8] move data', 'SCL', 0, null, 'true'],
          ],
        ),
      )
    }
    return frame(rowsPayload(['name', 'value'], [['language', 'SCL']]))
  })

  const outcome = await executeTool(byName['knowledge_block'], { block: 'Main', db_path: DB }, execIn('C:\\ws'))
  const details = outcome.details.join('\n')

  assert.match(details, /Networks: 2 of 2, 1 commented out/)
  assert.match(details, /- \[32\] Step\[8\] move data \(SCL\), 0 logic char\(s\), COMMENTED OUT/)
  assert.equal(outcome.data.networks[1].commented, true)
})

// ------------------------------------------------------- the field budget

test('knowledge_query can read one long value whole when max_field_chars asks for it', async () => {
  const long = 'L'.repeat(900)
  const context = createTestContext()
  tools.registerTools(context.ctx, {
    request: async (_operation, params) =>
      frame({ dbPath: params.dbPath, columns: ['logic'], rows: [[long]], rowCount: 1, truncated: false }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const definition = context.definitions.find((candidate) => candidate.name === 'knowledge_query')

  const cut = await executeTool(definition, { sql: 'SELECT logic FROM x', db_path: DB }, execIn('C:\\ws'))
  const cutText = renderedText(definition, { sql: 'SELECT logic FROM x', db_path: DB }, cut)
  assert.match(cutText, /cut at 200 characters/)
  assert.match(cutText, /max_field_chars \(up to 3500\)/)
  assert.ok(!cutText.includes(long), 'the default budget must not deliver the whole value')

  const whole = await executeTool(
    definition,
    { sql: 'SELECT logic FROM x', db_path: DB, max_field_chars: 3000 },
    execIn('C:\\ws'),
  )
  const wholeText = renderedText(definition, { sql: 'SELECT logic FROM x', db_path: DB, max_field_chars: 3000 }, whole)
  assert.ok(wholeText.includes(long), 'the raised budget must deliver the value whole')
  assert.ok(!wholeText.includes('cut at 200 characters'))
})
test('knowledge_block reports the block total, not the page size', async () => {
  const { byName } = await harness((sql) => {
    if (sql.includes("FROM graph_nodes\nWHERE kind IN ('OB', 'FB', 'FC')")) {
      return frame(rowsPayload(['id', 'kind', 'name'], [['block:Main', 'FB', 'Main']]))
    }
    if (sql.includes('FROM knowledge_networks')) {
      return frame(
        rowsPayload(
          [
            'network_index',
            'network_id',
            'title',
            'language',
            'coalesce(length(logic_statements), 0)',
            'source_file',
            'commented',
            'region_path',
            'segment_kind',
            'total',
            'commented_total',
          ],
          [
            [1, 'network:Main:1', 'Start', 'LAD', 120, null, null, null, 'network', 72, 2],
            [2, 'network:Main:2', null, 'LAD', 40, null, 'true', null, 'network', 72, 2],
          ],
        ),
      )
    }
    return frame(rowsPayload(['name', 'value'], [['language', 'LAD']]))
  })

  const outcome = await executeTool(byName['knowledge_block'], { block: 'Main', max_networks: 2, db_path: DB }, execIn('C:\\ws'))

  assert.equal(outcome.data.total, 72, 'the total must come from the statement, not from the two rows shown')
  assert.equal(outcome.data.commentedTotal, 2)
  assert.equal(outcome.data.returned, 2)
  assert.equal(outcome.data.truncated, true)
  assert.match(outcome.summary, /Main \(FB\): 72 network\(s\), first 2 listed, 2 commented out/)
  assert.match(outcome.details.join('\n'), /Networks: 2 of 72 \(first page; raise max_networks to see the rest\), 2 commented out/)
})