/**
 * SCL segmentation through the real engine (docs/decisions.md D27).
 *
 * The committed fixtures cover a real Siemens library block (four flat REGIONs,
 * constants, calls, documentation comments). They cannot cover the awkward half
 * of the rule set: nested regions, a region opened *inside* an IF, a region body
 * larger than the tool's 6,000-character read cap, code outside every region, and
 * a REGION whose whole body is a comment. So this test writes one block that has
 * exactly those shapes, ingests it through the real engine, and asserts what the
 * model will actually see.
 *
 * The engine is a build artifact (`.gitignore` excludes `engine/bin/`), so on a
 * checkout where the C# half has not been built this test **skips with the command
 * to fix that** instead of failing.
 *
 * @module dsh-engineering-graph/test/scl-segmentation
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { engineAvailable, engineClient, engineSkipReason } from './helpers/harness.mjs'

/** The tool's hard cap on one `knowledge_network` read; parts must respect it. */
const MAX_SEGMENT_CHARS = 6000

test('a real engine ingest segments one SCL block into regions, modules and parts', async (t) => {
  if (!engineAvailable) {
    t.skip(engineSkipReason)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-engineering-graph-scl-'))
  const blocks = join(dir, 'blocks')
  mkdirSync(blocks)

  writeFileSync(join(blocks, 'SclSegmented.xml'), buildBlockXml(), 'utf8')

  const dbPath = join(dir, 'plc-knowledge.db')
  const client = await engineClient()
  // One hook, engine first: the engine keeps the database open, and on Windows a
  // delete of an open file fails — a second hook registered earlier would run first
  // and, when it throws, leave the child alive for the rest of the process.
  t.after(async () => {
    try {
      await client.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await client.start()
  const ingest = await client.request('Ingest', { deviceDir: dir, dbPath })
  assert.equal(ingest.ok, true, JSON.stringify(ingest.error))

  const networks = await query(client, dbPath, NETWORK_SQL)
  const rows = networks.map((row) => ({
    index: row[0],
    title: row[1],
    kind: row[2],
    regionPath: row[3],
    chars: row[4],
    commented: row[5],
    control: row[6],
    tiaNetwork: row[7],
  }))

  // 1. One segment per region, a module segment for the code outside every region,
  //    two parts for the oversized region, and the comment-only region kept.
  assert.equal(rows.length, 7, `expected 7 segments, got ${JSON.stringify(rows, null, 2)}`)
  assert.deepEqual(
    rows.map((row) => row.index),
    [1, 2, 3, 4, 5, 6, 7],
    'segment indices are 1-based and sequential in source order',
  )
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['module', 'region', 'region', 'region', 'part', 'part', 'region'],
  )

  // 2. Titles: the region path for regions, the CompileUnit title for the module.
  assert.equal(rows[0].title, 'Segment me')
  assert.equal(rows[1].title, 'OUTER')
  assert.equal(rows[2].title, 'OUTER / INNER')
  assert.equal(rows[3].title, 'OUTER')
  assert.match(rows[4].title, /^BIG \(part 1\/2\)$/)
  assert.match(rows[5].title, /^BIG \(part 2\/2\)$/)
  assert.equal(rows[6].title, 'DOC')

  // 3. A region opened inside an IF says which structure it is inside. The segment
  //    after the nested region also starts inside that IF (its body carries the
  //    closing END_IF), so it reports the same context.
  assert.equal(rows[1].control, '', 'the first OUTER segment starts before the IF')
  assert.equal(rows[2].control, 'IF cond THEN')
  assert.equal(rows[3].control, 'IF cond THEN', 'this segment starts before the END_IF that its body contains')

  // 4. Contract of the read cap: every executable segment fits in one tool call.
  for (const row of rows) {
    assert.ok(row.chars <= MAX_SEGMENT_CHARS, `segment ${row.index} is ${row.chars} chars`)
  }

  // 5. The comment-only region has no executable logic, and its text is kept
  //    separately (D25's rule, still true per segment).
  assert.equal(rows[6].commented, 'true')
  assert.equal(rows[6].chars, 0)

  // 6. Per-segment access attribution: the nested region only reads and writes
  //    what its own body touches, which is the whole point of the split.
  const inner = await query(client, dbPath, ACCESS_SQL, { index: 3 })
  assert.deepEqual(
    inner.filter((row) => row[0] === 'WRITES').map((row) => row[1]),
    ['c', 'e'],
  )
  assert.deepEqual(
    inner.filter((row) => row[0] === 'READS').map((row) => row[1]),
    ['d', 'f'],
  )

  const outer = await query(client, dbPath, ACCESS_SQL, { index: 2 })
  assert.deepEqual(
    outer.filter((row) => row[0] === 'WRITES').map((row) => row[1]),
    ['a'],
    'the OUTER segment before the nested region owns only its own assignment',
  )

  // 7. Segment text carries the region body only — no REGION/END_REGION lines and
  //    no repeated region name from the END_REGION header.
  const logic = await query(client, dbPath, LOGIC_SQL, { index: 4 })
  assert.equal(logic.length, 1)
  const segmentText = logic[0][0]
  assert.ok(!segmentText.includes('REGION'), `segment text still mentions REGION: ${segmentText}`)
  assert.ok(segmentText.includes('END_IF'), 'the closing END_IF belongs to the segment that follows the nested region')
})

// ------------------------------------------------------------------ statements

const NETWORK_SQL = `
SELECT n.network_index,
       n.title,
       coalesce((SELECT value FROM graph_node_properties p WHERE p.node_id = n.network_id AND p.name = 'segmentKind'), 'network'),
       coalesce((SELECT value FROM graph_node_properties p WHERE p.node_id = n.network_id AND p.name = 'regionPath'), ''),
       coalesce(length(n.logic_statements), 0),
       coalesce((SELECT value FROM graph_node_properties p WHERE p.node_id = n.network_id AND p.name = 'logicCommented'), 'false'),
       coalesce((SELECT value FROM graph_node_properties p WHERE p.node_id = n.network_id AND p.name = 'enclosingControl'), ''),
       (SELECT value FROM graph_node_properties p WHERE p.node_id = n.network_id AND p.name = 'tiaNetworkIndex')
FROM knowledge_networks n
WHERE n.block_id = 'block:SclSegmented'
ORDER BY n.network_index
`

const ACCESS_SQL = `
SELECT a.access, a.variable_name
FROM knowledge_network_accesses a
JOIN knowledge_networks n ON n.network_id = a.network_id
WHERE n.block_id = 'block:SclSegmented' AND n.network_index = @index
ORDER BY a.access, a.variable_name
`

const LOGIC_SQL = `
SELECT coalesce(logic_statements, '')
FROM knowledge_networks
WHERE block_id = 'block:SclSegmented' AND network_index = @index
`

/** Runs one read-only statement; `@name` placeholders are replaced by literals the test controls. */
async function query(client, dbPath, sql, values = {}) {
  let text = sql
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`@${name}`, String(value))
  }

  const frame = await client.request('Query', { dbPath, sql: text })
  assert.equal(frame.ok, true, JSON.stringify(frame.error))
  return frame.data.rows
}

// ------------------------------------------------------------------ XML builder

/**
 * The block under test:
 *
 * ```
 * x := y;                        ← unregioned code  → module segment
 * REGION OUTER
 *   a := b;                      ← OUTER, own text
 *   IF cond THEN
 *     REGION INNER               ← nested, opened inside an IF
 *       c := d; e := f;
 *     END_REGION
 *   END_IF;
 *   g := h;                      ← OUTER, after the nested region
 * REGION BIG                     ← > 6,000 characters → two parts
 *   ...
 * REGION DOC
 *   // prose only                ← comment-only region
 * ```
 */
function buildBlockXml() {
  const text = []
  text.push(statement('x', 'y'))
  text.push(regionOpen('OUTER'))
  text.push(statement('a', 'b'))
  text.push(token('IF'), blank(), accessRead('cond'), blank(), token('THEN'), newLine())
  text.push(regionOpen('INNER'))
  text.push(statement('c', 'd'))
  text.push(statement('e', 'f'))
  text.push(regionClose('INNER'))
  text.push(token('END_IF'), token(';'), newLine())
  text.push(statement('g', 'h'))
  text.push(regionClose('OUTER'))
  text.push(regionOpen('BIG'))
  for (let index = 0; index < 120; index++) {
    text.push(statement(`bigTargetNumber${index}WithALongName`, `bigSourceNumber${index}WithALongName`))
  }
  text.push(regionClose('BIG'))
  text.push(regionOpen('DOC'))
  text.push(lineComment('Documentation only: this region never runs.'))
  text.push(regionClose('DOC'))

  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V17" />
  <DocumentInfo>
    <Created>2026-10-21T00:00:00.0000000Z</Created>
    <ExportSetting>WithDefaults</ExportSetting>
  </DocumentInfo>
  <SW.Blocks.FC ID="0">
    <AttributeList>
      <AutoNumber>true</AutoNumber>
      <HeaderVersion>0.1</HeaderVersion>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="None" />
</Sections></Interface>
      <Name>SclSegmented</Name>
      <Number>90</Number>
      <ProgrammingLanguage>SCL</ProgrammingLanguage>
    </AttributeList>
    <ObjectList>
      <SW.Blocks.CompileUnit ID="3" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource><StructuredText xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/StructuredText/v3">
${text.map((line) => `  ${line}`).join('\n')}
</StructuredText></NetworkSource>
          <ProgrammingLanguage>SCL</ProgrammingLanguage>
        </AttributeList>
        <ObjectList>
          <MultilingualText ID="4" CompositionName="Comment">
            <ObjectList>
              <MultilingualTextItem ID="5" CompositionName="Items">
                <AttributeList>
                  <Culture>en-US</Culture>
                  <Text />
                </AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
          <MultilingualText ID="6" CompositionName="Title">
            <ObjectList>
              <MultilingualTextItem ID="7" CompositionName="Items">
                <AttributeList>
                  <Culture>en-US</Culture>
                  <Text>Segment me</Text>
                </AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
        </ObjectList>
      </SW.Blocks.CompileUnit>
    </ObjectList>
  </SW.Blocks.FC>
</Document>
`
}

/** Openness requires unique UIds inside a CompileUnit; the value itself is opaque to the engine. */
let uid = 100

function nextUid() {
  uid += 1
  return `u${uid}`
}

function blank() {
  return `<Blank Num="1" UId="${nextUid()}" />`
}

function newLine() {
  return `<NewLine Num="1" UId="${nextUid()}" />`
}

function token(value) {
  return `<Token Text="${value}" UId="${nextUid()}" />`
}

function accessRead(name) {
  return `<Access Scope="LocalVariable" UId="${nextUid()}"><Symbol UId="${nextUid()}"><Component Name="${name}" UId="${nextUid()}" /></Symbol></Access>`
}

/** `target := source;` as the token stream Openness writes for an SCL assignment. */
function statement(target, source) {
  return `${accessRead(target)}${blank()}${token(':=')}${blank()}${accessRead(source)}${token(';')}${newLine()}`
}

function lineComment(value) {
  return `<LineComment Inserted="false" NoClosingBracket="false" UId="${nextUid()}"><Text UId="${nextUid()}">${value}</Text></LineComment>${newLine()}`
}

/** Openness writes the region name after the opening token… */
function regionOpen(name) {
  return `${token('REGION')}${blank()}<Text UId="${nextUid()}">${name}</Text>${newLine()}`
}

/** …and repeats it after the closing token, which must not leak into the next segment. */
function regionClose(name) {
  return `${token('END_REGION')}${blank()}<Text UId="${nextUid()}">${name}</Text>${newLine()}`
}
