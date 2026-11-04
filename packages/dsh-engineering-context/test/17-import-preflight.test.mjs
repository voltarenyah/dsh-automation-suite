/**
 * `import_preflight` — what TIA would refuse, before the transaction starts.
 *
 * The three failure classes that actually happened on a live cross-project
 * import (2026-11-04) are held down here: a multilingual culture the target does
 * not have, a dependency imported out of order or missing, and a name that
 * already exists. The tool is also required to be honest when TIA is not there:
 * it still parses the XML and says which checks were skipped.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadConfigModule,
  loadToolsModule,
  makeFile,
  tempWorkspace,
} from './helpers/harness.mjs'

const { toolDefinitions } = await loadToolsModule()
const { resolveConfig } = await loadConfigModule()

const PREFLIGHT = 'import_preflight'
const DEVICE = 'PLC1'
const SOFTWARE = 'SW1'

function openSession(overrides = {}) {
  return {
    running: true,
    projectOpen: true,
    projectName: 'TARGET',
    projectPath: 'C:\\TIA\\TARGET.ap17',
    isModified: false,
    software: [{ device: DEVICE, software: SOFTWARE, blockCount: 1 }],
    reason: null,
    ...overrides,
  }
}

/**
 * A fake `engineeringAccess` service.
 *
 * `listObjects` and `readProjectLanguages` are the two optional methods the
 * preflight needs; the base four are present because `engineeringAccess()`
 * refuses a service that does not look like the real one.
 */
function service(options = {}) {
  const {
    session = openSession(),
    languages = { ok: true, data: { activeLanguages: [{ culture: 'en-GB' }], supportedLanguages: [] } },
    listing = { ok: true, objects: [{ category: 'blocks', name: 'FB_Test', group: null }], families: {}, truncated: false },
  } = options
  return {
    async readTiaSession() {
      return session
    },
    async readProjectLanguages() {
      return languages
    },
    async listObjects() {
      return listing
    },
    async openProject() {
      throw new Error('import_preflight must never open a project')
    },
    async saveProjectAs() {
      throw new Error('import_preflight must never save a project')
    },
    async rebuildSource() {
      throw new Error('import_preflight must never rebuild a source tree')
    },
  }
}

function preflightTool(services) {
  const { ctx } = createTestContext({ services: services ?? {} })
  const definitions = toolDefinitions({ ctx, config: resolveConfig(), log: ctx.logger })
  return findTool(definitions, PREFLIGHT)
}

const TYPE_DEP = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Types.PlcStruct ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
        <Section Name="None"><Member Name="A" Datatype="Bool"/></Section>
      </Sections></Interface>
      <Name>UDT_Dep</Name>
    </AttributeList>
    <ObjectList>
      <MultilingualText ID="1"><ObjectList>
        <MultilingualTextItem ID="2"><AttributeList><Culture>en-GB</Culture><Text /></AttributeList></MultilingualTextItem>
      </ObjectList></MultilingualText>
    </ObjectList>
  </SW.Types.PlcStruct>
</Document>`

const TYPE_TEST = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Types.PlcStruct ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
        <Section Name="None">
          <Member Name="A" Datatype="Bool"/>
          <Member Name="B" Datatype="&quot;UDT_Dep&quot;"/>
        </Section>
      </Sections></Interface>
      <Name>UDT_Test</Name>
    </AttributeList>
    <ObjectList>
      <MultilingualText ID="1"><ObjectList>
        <MultilingualTextItem ID="2"><AttributeList><Culture>th-TH</Culture><Text /></AttributeList></MultilingualTextItem>
        <MultilingualTextItem ID="3"><AttributeList><Culture>en-GB</Culture><Text /></AttributeList></MultilingualTextItem>
      </ObjectList></MultilingualText>
    </ObjectList>
  </SW.Types.PlcStruct>
</Document>`

const BLOCK = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.FB ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
        <Section Name="None"><Member Name="Dep" Datatype="&quot;UDT_Missing&quot;"/></Section>
      </Sections></Interface>
      <Name>FB_Test</Name>
      <Number>7</Number>
    </AttributeList>
  </SW.Blocks.FB>
</Document>`

const INSTANCE_DB = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.InstanceDB ID="0">
    <AttributeList>
      <InstanceOfName>FB_Test</InstanceOfName>
      <Name>FB_Test_DB</Name>
    </AttributeList>
  </SW.Blocks.InstanceDB>
</Document>`

async function batch(t) {
  const root = await tempWorkspace(t)
  const files = {
    typeTest: await makeFile(join(root, 'in', 'UDT_Test.xml'), TYPE_TEST),
    typeDep: await makeFile(join(root, 'in', 'UDT_Dep.xml'), TYPE_DEP),
    block: await makeFile(join(root, 'in', 'FB_Test.xml'), BLOCK),
    instanceDb: await makeFile(join(root, 'in', 'FB_Test_DB.xml'), INSTANCE_DB),
  }
  return { root, files }
}

test('reports the live failures: culture, existing name, dependency order', async (t) => {
  const { root, files } = await batch(t)

  const outcome = assertEnvelope(
    await executeTool(
      preflightTool({ engineeringAccess: service() }),
      { import_paths: [join(root, 'in')], reference: 'SWT2@4af0a95' },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.match(outcome.summary, /^DO NOT IMPORT YET/u)
  assert.equal(outcome.data.reference, 'SWT2@4af0a95')

  const blocking = outcome.data.blocking.map((issue) => issue.code)
  assert.ok(blocking.includes('language_not_active'), `blocking was ${blocking.join(', ')}`)
  assert.ok(blocking.includes('name_exists'), `blocking was ${blocking.join(', ')}`)
  const warningCodes = outcome.data.warnings.map((issue) => issue.code)
  assert.ok(warningCodes.includes('dependency_unresolved'), `warnings were ${warningCodes.join(', ')}`)

  const byName = Object.fromEntries(outcome.data.objects.map((entry) => [entry.name ?? entry.path, entry]))
  assert.deepEqual(byName['UDT_Test'].dependencies, ['UDT_Dep'])
  assert.deepEqual(byName['UDT_Test'].cultures, ['en-GB', 'th-TH'])
  assert.equal(byName['FB_Test'].number, '7')
  assert.equal(byName['FB_Test_DB'].instanceOf, 'FB_Test')
  assert.equal(byName['FB_Test_DB'].instanceDb, true)

  // Types first, the referenced type before the type that uses it, then the
  // block, then its instance DB.
  const order = outcome.data.suggestedOrder
  assert.equal(order[0], files.typeDep)
  assert.ok(order.indexOf(files.typeTest) < order.indexOf(files.block))
  assert.ok(order.indexOf(files.block) < order.indexOf(files.instanceDb))
  assert.match(outcome.details.join('\n'), /Reference: SWT2@4af0a95/u)
  assert.match(outcome.details.join('\n'), /Target: TARGET — active languages: en-GB/u)
})

test('without a TIA service it still parses the XML and says what was skipped', async (t) => {
  const { root } = await batch(t)

  const outcome = assertEnvelope(
    await executeTool(preflightTool(undefined), { import_paths: [join(root, 'in')] }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.target, null)
  assert.ok(outcome.warnings.some((warning) => /no engineeringAccess service/u.test(warning)))
  assert.equal(outcome.data.blocking.some((issue) => issue.code === 'language_not_active'), false, 'no active set = no culture verdict')
  assert.equal(outcome.data.blocking.some((issue) => issue.code === 'name_exists'), false, 'no listing = no name verdict')
})

test('a closed project degrades to the XML checks with a warning', async (t) => {
  const { root } = await batch(t)

  const outcome = assertEnvelope(
    await executeTool(
      preflightTool({ engineeringAccess: service({ session: openSession({ projectOpen: false, reason: 'no project is open' }) }) }),
      { import_paths: [join(root, 'in')] },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.target, null)
  assert.ok(outcome.warnings.some((warning) => /no project open/u.test(warning)))
  assert.equal(outcome.data.blocking.some((issue) => issue.code === 'name_exists'), false)
})

test('missing paths and non-XML files are warnings, not a failure', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(join(root, 'notes.txt'), 'not xml')

  const outcome = assertEnvelope(
    await executeTool(
      preflightTool({ engineeringAccess: service() }),
      { import_paths: [join(root, 'missing.xml'), join(root, 'notes.txt')] },
      fakeExec(root),
    ),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.stats.files, 0)
  const warnings = outcome.warnings.join('\n')
  assert.match(warnings, /does not exist/u)
  assert.match(warnings, /not a Simatic ML XML file/u)
})

test('an unparsable XML file is reported, not dropped', async (t) => {
  const root = await tempWorkspace(t)
  await makeFile(join(root, 'bad.xml'), '<Document><broken')

  const outcome = assertEnvelope(
    await executeTool(preflightTool({ engineeringAccess: service() }), { import_paths: [join(root, 'bad.xml')] }, fakeExec(root)),
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.stats.unparsed, 1)
  assert.equal(outcome.data.warnings[0].code, 'unparsable')
})

test('a type that sorts after the type it references is flagged, and the order is corrected', async (t) => {
  const root = await tempWorkspace(t)
  const referencing = `<?xml version="1.0" encoding="utf-8"?>
<Document><SW.Types.PlcStruct ID="0"><AttributeList>
  <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
    <Section Name="None"><Member Name="X" Datatype="&quot;UDT_ZDep&quot;"/></Section>
  </Sections></Interface>
  <Name>UDT_ATest</Name>
</AttributeList></SW.Types.PlcStruct></Document>`
  const dependency = `<?xml version="1.0" encoding="utf-8"?>
<Document><SW.Types.PlcStruct ID="0"><AttributeList>
  <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
    <Section Name="None"><Member Name="Y" Datatype="Bool"/></Section>
  </Sections></Interface>
  <Name>UDT_ZDep</Name>
</AttributeList></SW.Types.PlcStruct></Document>`
  const aFile = await makeFile(join(root, 'in', 'A_UDT.xml'), referencing)
  const zFile = await makeFile(join(root, 'in', 'Z_UDT.xml'), dependency)

  const outcome = assertEnvelope(
    await executeTool(preflightTool({ engineeringAccess: service() }), { import_paths: [join(root, 'in')] }, fakeExec(root)),
  )

  assert.ok(
    outcome.data.warnings.some((issue) => issue.code === 'type_order'),
    `warnings were ${outcome.data.warnings.map((issue) => issue.code).join(', ')}`,
  )
  assert.deepEqual(outcome.data.suggestedOrder, [zFile, aFile])
})

test('an empty import_paths is refused', async (t) => {
  const root = await tempWorkspace(t)
  const outcome = assertEnvelope(await executeTool(preflightTool({ engineeringAccess: service() }), { import_paths: [] }, fakeExec(root)))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_argument')
})
