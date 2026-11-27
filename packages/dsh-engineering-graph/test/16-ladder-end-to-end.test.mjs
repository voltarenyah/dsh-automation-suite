/**
 * The LAD rung view, end to end: block XML → real engine ingest → stored property → tool reply.
 *
 * Why a real engine and not the stub: the stub tests in `12-drilldown.test.mjs` prove the tool
 * renders whatever a row contains, and the engine self-test proves the rung text can be computed
 * from a network. Neither proves the two halves are joined — that `LadderText` reaches the property
 * store under the name the SQL asks for, for a block the tool can resolve. A rename on either side
 * leaves both existing suites green while the model silently gets the statement text instead of the
 * rungs, so this test walks the whole path.
 *
 * The engine is a build artifact (`.gitignore` excludes `engine/bin/`), so on a checkout where the
 * C# half has not been built this test skips with the command to fix that.
 *
 * @module dsh-engineering-graph/test/ladder-end-to-end
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createTestContext,
  engineAvailable,
  engineClient,
  engineSkipReason,
  executeTool,
  loadToolsModule,
} from './helpers/harness.mjs'

const BLOCK = 'LadderE2E'

test('a real ingest stores a rung view and the tool serves it for view=ladder', async (t) => {
  if (!engineAvailable) {
    t.skip(engineSkipReason)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-engineering-graph-ladder-'))
  const blocks = join(dir, 'blocks')
  mkdirSync(blocks)
  writeFileSync(join(blocks, `${BLOCK}.xml`), buildBlockXml(), 'utf8')

  const dbPath = join(dir, 'plc-knowledge.db')
  const client = await engineClient()
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

  // 1. The property is stored, under the name the network statement selects.
  const stored = await query(
    client,
    dbPath,
    `SELECT n.network_index, p.value FROM knowledge_networks n
       JOIN graph_node_properties p ON p.node_id = n.network_id
      WHERE n.block_id = 'block:${BLOCK}' AND p.name = 'ladderText'
      ORDER BY n.network_index`,
  )
  assert.equal(stored.length, 2, 'both networks must carry a rung view')
  assert.deepEqual(stored.map((row) => row[0]), [1, 2])

  const first = String(stored[0][1])
  const second = String(stored[1][1])

  // Network 1: one path, one contact, one plain coil.
  assert.match(first, /\(=\) Q1/, 'the coil and its marker')
  assert.match(first, /<- {2}A\b/, 'the single condition, with no AND')

  // Network 2: two paths into one OR box → two lines for the same set coil.
  const q2Lines = second.split('\n').filter((line) => line.includes('Q2'))
  assert.equal(q2Lines.length, 2, `expected two paths for Q2, got ${JSON.stringify(q2Lines)}`)
  assert.ok(q2Lines.every((line) => line.includes('(S)')), 'the coil is a set coil')
  assert.ok(
    q2Lines.some((line) => line.includes('B')) && q2Lines.some((line) => line.includes('C')),
    `the two alternatives must be B and C, got ${JSON.stringify(q2Lines)}`,
  )
  assert.ok(
    q2Lines.every((line) => !line.includes('O')),
    'the OR box is structure, not a condition, so it must not appear as a term',
  )

  // 2. The tool serves it. This is the join the stub tests cannot see.
  const tools = await loadToolsModule()
  const context = createTestContext()
  tools.registerTools(
    context.ctx,
    {
      request: (operation, params) => client.request(operation, params),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    },
    { includeIngest: false, includeDrilldown: 'all' },
  )
  const byName = Object.fromEntries(context.definitions.map((definition) => [definition.name, definition]))
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: dir } } } }

  const ladder = await executeTool(
    byName['knowledge_network'],
    { block: BLOCK, index: 2, view: 'ladder', db_path: dbPath },
    exec,
  )
  assert.equal(ladder.ok, true, JSON.stringify(ladder.error))
  const ladderDetails = ladder.details.join('\n')
  assert.match(ladderDetails, /Rungs \(one line per path/)
  assert.match(ladderDetails, /\(S\) Q2/)
  assert.ok(!ladderDetails.includes('Q2 := '), 'the rung view replaces the statement text')

  // 3. Without the flag the reply is the statement text, so the default does not change.
  const logic = await executeTool(byName['knowledge_network'], { block: BLOCK, index: 2, db_path: dbPath }, exec)
  assert.equal(logic.ok, true, JSON.stringify(logic.error))
  const logicDetails = logic.details.join('\n')
  assert.ok(!logicDetails.includes('Rungs (one line per path'), 'logic remains the default view')
})

/** Runs one read-only statement against the engine. */
async function query(client, dbPath, sql) {
  const frame = await client.request('Query', { dbPath, sql })
  assert.equal(frame.ok, true, JSON.stringify(frame.error))
  return frame.data.rows
}

// ------------------------------------------------------------------ XML builder

/** One LAD contact/coil network, plus a two-branch OR box ending in a set coil. */
function buildBlockXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V17" />
  <DocumentInfo>
    <Created>2026-11-27T00:00:00.0000000Z</Created>
    <ExportSetting>WithDefaults</ExportSetting>
  </DocumentInfo>
  <SW.Blocks.FC ID="0">
    <AttributeList>
      <AutoNumber>true</AutoNumber>
      <HeaderVersion>0.1</HeaderVersion>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="None" />
</Sections></Interface>
      <Name>${BLOCK}</Name>
      <Number>91</Number>
      <ProgrammingLanguage>LAD</ProgrammingLanguage>
    </AttributeList>
    <ObjectList>
${compileUnit('1', networkOne())}
${compileUnit('2', networkTwo())}
    </ObjectList>
  </SW.Blocks.FC>
</Document>
`
}

function compileUnit(id, flgNet) {
  return `      <SW.Blocks.CompileUnit ID="${id}" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource>${flgNet}</NetworkSource>
          <ProgrammingLanguage>LAD</ProgrammingLanguage>
        </AttributeList>
        <ObjectList>
          <MultilingualText CompositionName="Title">
            <ObjectList>
              <MultilingualTextItem CompositionName="Items">
                <AttributeList>
                  <Culture>en-US</Culture>
                  <Text>Network ${id}</Text>
                </AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
        </ObjectList>
      </SW.Blocks.CompileUnit>`
}

/** rail → [A] → (=) Q1 */
function networkOne() {
  return `<FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4">
  <Parts>
    <Access Scope="LocalVariable" UId="1"><Symbol><Component Name="A" /></Symbol></Access>
    <Access Scope="LocalVariable" UId="2"><Symbol><Component Name="Q1" /></Symbol></Access>
    <Part Name="Contact" UId="10" />
    <Part Name="Coil" UId="11" />
  </Parts>
  <Wires>
    <Wire UId="20"><Powerrail /><NameCon UId="10" Name="in" /></Wire>
    <Wire UId="21"><IdentCon UId="1" /><NameCon UId="10" Name="operand" /></Wire>
    <Wire UId="22"><NameCon UId="10" Name="out" /><NameCon UId="11" Name="in" /></Wire>
    <Wire UId="23"><IdentCon UId="2" /><NameCon UId="11" Name="operand" /></Wire>
  </Wires>
</FlgNet>`
}

/** rail → [B] → O.in1, [C] → O.in2, O.out → (S) Q2 */
function networkTwo() {
  return `<FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4">
  <Parts>
    <Access Scope="LocalVariable" UId="1"><Symbol><Component Name="B" /></Symbol></Access>
    <Access Scope="LocalVariable" UId="2"><Symbol><Component Name="C" /></Symbol></Access>
    <Access Scope="LocalVariable" UId="3"><Symbol><Component Name="Q2" /></Symbol></Access>
    <Part Name="Contact" UId="10" />
    <Part Name="Contact" UId="11" />
    <Part Name="O" UId="12"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part>
    <Part Name="SCoil" UId="13" />
  </Parts>
  <Wires>
    <Wire UId="20"><Powerrail /><NameCon UId="10" Name="in" /><NameCon UId="11" Name="in" /></Wire>
    <Wire UId="21"><IdentCon UId="1" /><NameCon UId="10" Name="operand" /></Wire>
    <Wire UId="22"><IdentCon UId="2" /><NameCon UId="11" Name="operand" /></Wire>
    <Wire UId="23"><NameCon UId="10" Name="out" /><NameCon UId="12" Name="in1" /></Wire>
    <Wire UId="24"><NameCon UId="11" Name="out" /><NameCon UId="12" Name="in2" /></Wire>
    <Wire UId="25"><NameCon UId="12" Name="out" /><NameCon UId="13" Name="in" /></Wire>
    <Wire UId="26"><IdentCon UId="3" /><NameCon UId="13" Name="operand" /></Wire>
  </Wires>
</FlgNet>`
}
