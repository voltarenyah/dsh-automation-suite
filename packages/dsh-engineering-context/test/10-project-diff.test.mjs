/**
 * `project_diff` — the read-only structural explanation of a revision.
 *
 * The repository, the XML and git are real; only the `gitContext` *service* is a
 * test double, because the host composition does not exist here. The double
 * shells out to the same read-only git commands, so `git diff` / `git show` /
 * `git ls-files` and the parser are exercised end to end.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertEnvelope,
  createTestContext,
  executeTool,
  fakeExec,
  findTool,
  loadConfigModule,
  loadDiffEntryModule,
  loadToolsModule,
  makeFile,
  packageRoot,
  tempWorkspace,
} from './helpers/harness.mjs'

const { resolveConfig } = await loadConfigModule()
const { toolDefinitions } = await loadToolsModule()
const diffEntry = await loadDiffEntryModule()
const execFileAsync = promisify(execFile)

const DIFF = 'project_diff'
const DEVICE = 'PLC1'
const BLOCK_PATH = 'blocks/010/FC1.xml'

// ---------------------------------------------------------------------------
// Git and the gitContext double
// ---------------------------------------------------------------------------

async function git(root, args) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : (error.status ?? 1), stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/**
 * A `gitContext` service backed by real git, recording only what a write would
 * look like so a test can assert no write ever happened.
 */
function gitContextFor(root) {
  const calls = []
  const bound = {
    repoDir: root,
    async run(args) {
      calls.push({ operation: 'run', args })
      return await git(root, args)
    },
    async runChecked(args) {
      const result = await bound.run(args)
      if (result.code !== 0) throw new Error(result.stderr)
      return { stdout: result.stdout, stderr: result.stderr }
    },
    async status(paths) {
      calls.push({ operation: 'status', paths })
      const result = await git(root, ['status', '--porcelain', '--', ...paths])
      return result.stdout.split(/\r?\n/u).filter((line) => line.length > 0)
    },
    async head() {
      calls.push({ operation: 'head' })
      const result = await git(root, ['rev-parse', '--verify', 'HEAD'])
      return result.code === 0 ? result.stdout.trim() : null
    },
    async commit() {
      calls.push({ operation: 'WRITE-commit' })
      throw new Error('project_diff must never commit')
    },
  }
  const service = {
    async isRepository() {
      calls.push({ operation: 'isRepository' })
      return (await git(root, ['rev-parse', '--git-dir'])).code === 0
    },
    async repoRoot() {
      calls.push({ operation: 'repoRoot' })
      const result = await git(root, ['rev-parse', '--show-toplevel'])
      return result.code === 0 ? result.stdout.trim() : null
    },
    async create() {
      calls.push({ operation: 'create' })
      const check = await git(root, ['rev-parse', '--show-toplevel'])
      if (check.code !== 0) throw new Error(`not a repository: ${root}`)
      return bound
    },
    async init() {
      calls.push({ operation: 'WRITE-init' })
      throw new Error('project_diff must never initialize a repository')
    },
  }
  return { service, calls }
}

function diffToolFor(service) {
  const { ctx, definitions } = createTestContext({
    services: service === undefined ? {} : { gitContext: service },
  })
  diffEntry.apply(ctx, {})
  return { definitions, diff: findTool(definitions, DIFF) }
}

async function runDiff(t, root, args = {}, options = {}) {
  const { service } = options.service === undefined ? gitContextFor(root) : { service: options.service }
  const tools = diffToolFor(service)
  return assertEnvelope(await executeTool(tools.diff, args, fakeExec(root)))
}

async function initRepo(root) {
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Engineering Context Test'])
  await git(root, ['config', 'core.autocrlf', 'false'])
}

async function commitAll(root, message) {
  assert.equal((await git(root, ['add', '-A'])).code, 0)
  const committed = await git(root, ['commit', '-q', '-m', message])
  assert.equal(committed.code, 0, committed.stderr)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function unitXml(id, { parts, wires, accesses, title, text }) {
  const partXml = Array.from({ length: parts }, (_, index) => `
          <SW.Blocks.Part ID="${id * 100 + index}" CompositionName="Parts">
            <AttributeList><TemplateValue Name="Contact" /></AttributeList>
          </SW.Blocks.Part>`).join('')
  const wireXml = Array.from({ length: wires }, (_, index) => `
          <SW.Blocks.Wire ID="${id * 100 + 50 + index}" CompositionName="Wires" />`).join('')
  const accessXml = Array.from({ length: accesses }, (_, index) => `
          <SW.Blocks.Access ID="${id * 100 + 70 + index}" CompositionName="Access">
            <AttributeList><Symbol><Component Name="Start" /></Symbol></AttributeList>
          </SW.Blocks.Access>`).join('')
  return `
      <SW.Blocks.CompileUnit ID="${id}" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource><StructuredText>${text}</StructuredText></NetworkSource>
        </AttributeList>
        <ObjectList>${partXml}${wireXml}${accessXml}
        </ObjectList>
        <MultilingualText ID="${id * 10}">
          <ObjectList>
            <MultilingualTextItem ID="${id * 10 + 1}">
              <AttributeList><Culture>en-US</Culture><Text>${title}</Text></AttributeList>
            </MultilingualTextItem>
          </ObjectList>
        </MultilingualText>
      </SW.Blocks.CompileUnit>`
}

function memberXml(name, datatype) {
  return `<Member Name="${name}" Datatype="${datatype}" />`
}

function blockXml({ units, inputMembers, outputMembers, title, extraText = '' }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V17" />
  <SW.Blocks.FC ID="0">
    <AttributeList>
      <Name>FC1</Name>
      <Number>1</Number>
      <ProgrammingLanguage>LAD</ProgrammingLanguage>
      <MemoryLayout>Optimized</MemoryLayout>
      <Interface>
        <Sections>
          <Section Name="Input">
            ${inputMembers.join('\n            ')}
          </Section>
          <Section Name="Output">
            ${outputMembers.join('\n            ')}
          </Section>
        </Sections>
      </Interface>
    </AttributeList>
    <ObjectList>${units.join('')}
    </ObjectList>
    <MultilingualText ID="900">
      <ObjectList>
        <MultilingualTextItem ID="901">
          <AttributeList><Culture>en-US</Culture><Text>${title}</Text></AttributeList>
        </MultilingualTextItem>${extraText}
      </ObjectList>
    </MultilingualText>
  </SW.Blocks.FC>
</Document>
`
}

/** FC1 with the two units / three members / one title the baseline commit holds. */
function baselineXml() {
  return blockXml({
    units: [
      unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Start network', text: 'Start := TRUE;' }),
      unitXml(7, { parts: 1, wires: 1, accesses: 1, title: 'Second network', text: 'Done := Start;' }),
    ],
    inputMembers: [memberXml('Start', 'Bool'), memberXml('Count', 'Int')],
    outputMembers: [memberXml('Done', 'Bool')],
    title: 'Motor start',
  })
}

/** Adds one unit, one Part and one Access to unit 7, one member, and two text items. */
function revisedXml() {
  return blockXml({
    units: [
      unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Start network', text: 'Start := TRUE;' }),
      unitXml(7, { parts: 2, wires: 1, accesses: 2, title: 'Second network', text: 'Done := Start;' }),
      unitXml(30, { parts: 1, wires: 1, accesses: 2, title: 'Third network', text: 'Count := Count + 1;' }),
    ],
    inputMembers: [memberXml('Start', 'Bool'), memberXml('Count', 'Int'), memberXml('Mode', 'Int')],
    outputMembers: [memberXml('Done', 'Bool')],
    title: 'Motor start (revised)',
    extraText: `
        <MultilingualTextItem ID="902">
          <AttributeList><Culture>en-US</Culture><Text>Revision note</Text></AttributeList>
        </MultilingualTextItem>`,
  })
}

function evidenceDocument(objects, overrides = {}) {
  return {
    schemaVersion: 1,
    hashAlgo: 'sha256',
    device: DEVICE,
    software: 'SW1',
    plcChecksum: 'AA',
    stateId: 'state-1',
    objects,
    unexportable: [],
    tombstones: [],
    ...overrides,
  }
}

function fcObject(overrides = {}) {
  return {
    category: 'block',
    name: 'FC1',
    group: '010',
    path: BLOCK_PATH,
    fingerprint: {
      Code: 'code-1',
      Interface: 'interface-1',
      Comments: 'comments-1',
      Properties: 'properties-1',
    },
    contentHash: 'hash-1',
    ...overrides,
  }
}

async function writeDevice(root, { xml, evidence = evidenceDocument({ 'block||FC1': fcObject() }) } = {}) {
  const device = join(root, 'source', DEVICE)
  await makeFile(join(device, '_evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await makeFile(join(device, BLOCK_PATH), xml)
  return device
}

/** A repository with the baseline committed and the revised XML committed on top. */
async function committedProject(t) {
  const root = await tempWorkspace(t)
  await initRepo(root)
  await writeDevice(root, { xml: baselineXml() })
  await commitAll(root, 'baseline')
  await writeDevice(root, {
    xml: revisedXml(),
    evidence: evidenceDocument(
      {
        'block||FC1': fcObject({
          fingerprint: {
            Code: 'code-2',
            Interface: 'interface-1',
            Comments: 'comments-1',
            Properties: 'properties-1',
          },
          contentHash: 'hash-2',
        }),
      },
      { plcChecksum: 'BB', stateId: 'state-2' },
    ),
  })
  await commitAll(root, 'revise')
  return root
}

async function porcelain(root) {
  return (await git(root, ['status', '--porcelain', '--untracked-files=all'])).stdout
}

async function head(root) {
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
}

// ---------------------------------------------------------------------------
// The structural summary
// ---------------------------------------------------------------------------

test('project_diff defaults to HEAD~1 → HEAD and explains units, interface, text and faces', async (t) => {
  const root = await committedProject(t)
  const outcome = await runDiff(t, root)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)
  assert.equal(outcome.data.revisions.from, 'HEAD~1')
  assert.equal(outcome.data.revisions.to, 'HEAD')
  assert.equal(outcome.data.revisions.worktree, false)
  assert.equal(outcome.data.device.device, DEVICE)
  assert.equal(outcome.data.device.resolvedFrom, 'evidence')
  assert.equal(outcome.data.files.discovered, 1)
  assert.deepEqual(
    outcome.data.files.items,
    [{ path: `source/${DEVICE}/${BLOCK_PATH}`, change: 'modified' }],
  )
  assert.equal(outcome.data.files.added, 0)
  assert.equal(outcome.data.files.removed, 0)
  assert.equal(outcome.data.files.modified, 1)

  const block = outcome.data.blocks[0]
  assert.equal(block.identity.name, 'FC1')
  assert.equal(block.identity.group, '010')
  assert.equal(block.identity.kind, 'FC')
  assert.equal(block.identity.language, 'LAD')
  assert.equal(block.identity.category, 'block')
  assert.equal(block.identity.path, `source/${DEVICE}/${BLOCK_PATH}`)
  assert.equal(block.change, 'modified')
  assert.deepEqual(block.faces, { state: 'known', changed: ['Code'] })

  // 2 units → 3; the third is added, unit 7 changed by +1 Part and +1 Access.
  assert.equal(block.units.from, 2)
  assert.equal(block.units.to, 3)
  assert.deepEqual(block.units.added.items, [{ id: '30', label: 'Third network' }])
  assert.equal(block.units.removed.count, 0)
  assert.equal(block.units.changed.count, 1)
  assert.deepEqual(block.units.changed.items[0], {
    id: '7',
    label: 'Second network',
    parts: { from: 1, to: 2, delta: 1 },
    wires: { from: 1, to: 1, delta: 0 },
    accesses: { from: 1, to: 2, delta: 1 },
  })

  assert.equal(block.interface.from, 3)
  assert.equal(block.interface.to, 4)
  assert.deepEqual(block.interface.added.items, [{ section: 'Input', name: 'Mode', datatype: 'Int' }])
  assert.equal(block.interface.removed.count, 0)
  assert.equal(block.interface.changed.count, 0)

  // A retitled item is one removal; the retitle, "Third network" and
  // "Revision note" are additions.
  assert.equal(block.text.added.count, 3)
  assert.equal(block.text.removed.count, 1)
  assert.equal(block.text.removed.items[0].text, 'Motor start')
  assert.deepEqual(
    block.text.added.items.map((item) => item.text).sort(),
    ['Motor start (revised)', 'Revision note', 'Third network'],
  )

  // Bounded output: never the XML, never a whole document.
  const serialized = JSON.stringify(outcome)
  assert.ok(serialized.length < 20_000, `the result must stay bounded (was ${serialized.length} chars)`)
  assert.equal(serialized.includes('<SW.Blocks'), false)
  assert.equal(serialized.includes('StructuredText'), false)
  assert.match(outcome.summary, /1 XML file\(s\) changed/u)
  assert.match(outcome.summary, /1 modified/u)
})

test('max_items truncates every list while the counts stay exact', async (t) => {
  const root = await committedProject(t)
  const outcome = await runDiff(t, root, { max_items: 1 })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.filter.maxItems, 1)
  assert.equal(outcome.data.files.items.length, 1)
  const block = outcome.data.blocks[0]
  assert.equal(block.text.added.count, 3)
  assert.equal(block.text.added.items.length, 1)
  assert.equal(block.text.added.truncated, true)
  assert.equal(block.units.changed.count, 1)
  assert.equal(block.units.changed.items.length, 1)
  assert.equal(block.text.removed.count, 1)
  assert.equal(block.text.removed.items.length, 1)
})

test('a block filter resolves the path from the evidence ledger', async (t) => {
  const root = await committedProject(t)
  const outcome = await runDiff(t, root, { block: 'FC1' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.filter.block, 'FC1')
  assert.equal(outcome.data.files.discovered, 1)
  assert.equal(outcome.data.blocks[0].identity.name, 'FC1')

  const unknown = await runDiff(t, root, { block: 'GHOST' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'invalid_argument')
  assert.match(unknown.error.message, /not recorded with a file path/u)
})

test('a ledger path missing from both revisions is refused instead of reported as empty', async (t) => {
  const root = await tempWorkspace(t)
  await initRepo(root)
  await makeFile(
    join(root, 'source', DEVICE, '_evidence.json'),
    `${JSON.stringify(
      evidenceDocument({
        'block||FC1': fcObject({ name: 'GHOST', path: 'blocks/010/GHOST.xml' }),
      }),
      null,
      2,
    )}\n`,
  )
  await commitAll(root, 'baseline')
  await makeFile(join(root, 'README.txt'), 'second commit')
  await commitAll(root, 'second')

  const outcome = await runDiff(t, root, { block: 'GHOST' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_argument')
  assert.match(outcome.error.message, /exists in neither/u)
})

test('WORKTREE compares uncommitted changes and untracked new blocks', async (t) => {
  const root = await committedProject(t)

  // Uncommitted change to the tracked block: a fourth unit.
  const working = blockXml({
    units: [
      unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Start network', text: 'Start := TRUE;' }),
      unitXml(7, { parts: 1, wires: 1, accesses: 1, title: 'Second network', text: 'Done := Start;' }),
      unitXml(30, { parts: 1, wires: 1, accesses: 2, title: 'Third network', text: 'Count := Count + 1;' }),
      unitXml(40, { parts: 1, wires: 1, accesses: 1, title: 'Working network', text: 'Mode := 1;' }),
    ],
    inputMembers: [memberXml('Start', 'Bool'), memberXml('Count', 'Int'), memberXml('Mode', 'Int')],
    outputMembers: [memberXml('Done', 'Bool')],
    title: 'Motor start (revised)',
  })
  await writeFile(join(root, 'source', DEVICE, BLOCK_PATH), working, 'utf8')

  // An untracked, never-committed block in the same working tree.
  const second = blockXml({
    units: [unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'New', text: 'x := 1;' })],
    inputMembers: [memberXml('A', 'Bool')],
    outputMembers: [],
    title: 'Brand new',
  }).replace('<Name>FC1</Name>', '<Name>FC2</Name>')
  await makeFile(join(root, 'source', DEVICE, 'blocks', '010', 'FC2.xml'), second)

  const outcome = await runDiff(t, root, { from: 'HEAD', to: 'WORKTREE' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.data.revisions.worktree, true)
  assert.equal(outcome.data.revisions.to, 'WORKTREE')
  assert.equal(outcome.data.revisions.toCommit, null)
  assert.equal(outcome.data.files.discovered, 2)
  assert.equal(outcome.data.files.modified, 1)
  assert.equal(outcome.data.files.added, 1)
  assert.equal(outcome.data.blocks.length, 2)

  const fc1 = outcome.data.blocks.find((block) => block.identity.name === 'FC1')
  assert.equal(fc1.units.from, 3)
  assert.equal(fc1.units.to, 4)
  assert.equal(fc1.units.added.count, 1)
  const fc2 = outcome.data.blocks.find((block) => block.identity.name === 'FC2')
  assert.equal(fc2.change, 'added')
  assert.equal(fc2.units.from, 0)
  assert.equal(fc2.units.to, 1)
  assert.deepEqual(fc2.faces, { state: 'unknown', changed: [] })
})

test('a missing revision is refused before anything is read', async (t) => {
  const root = await committedProject(t)
  const outcome = await runDiff(t, root, { from: 'no-such-revision' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_argument')
  assert.match(outcome.error.message, /does not exist in this repository/u)
})

test('from=WORKTREE is refused; only to may be the working tree', async (t) => {
  const root = await committedProject(t)
  const outcome = await runDiff(t, root, { from: 'WORKTREE', to: 'HEAD' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'invalid_argument')
  assert.match(outcome.error.message, /only `to` may be WORKTREE/u)
})

// ---------------------------------------------------------------------------
// Device / service / repository refusals
// ---------------------------------------------------------------------------

test('multiple devices are refused without device, and selected with it', async (t) => {
  const root = await tempWorkspace(t)
  await initRepo(root)
  await writeDevice(root, { xml: baselineXml() })
  await makeFile(
    join(root, 'source', 'PLC2', '_evidence.json'),
    `${JSON.stringify(evidenceDocument({ 'block||FC2': fcObject({ name: 'FC2', path: 'blocks/020/FC2.xml' }) }), null, 2)}\n`,
  )
  await makeFile(
    join(root, 'source', 'PLC2', 'blocks', '020', 'FC2.xml'),
    blockXml({
      units: [unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Only', text: 'a := 1;' })],
      inputMembers: [memberXml('A', 'Bool')],
      outputMembers: [],
      title: 'PLC2 block',
    }).replace('<Name>FC1</Name>', '<Name>FC2</Name>'),
  )
  const plc2Block = blockXml({
    units: [unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Only', text: 'a := 1;' })],
    inputMembers: [memberXml('A', 'Bool')],
    outputMembers: [],
    title: 'PLC2 block',
  }).replace('<Name>FC1</Name>', '<Name>FC2</Name>')
  await makeFile(join(root, 'source', 'PLC2', 'blocks', '020', 'FC2.xml'), plc2Block)
  await commitAll(root, 'two devices')

  // The second commit changes PLC2 only, so the diff has exactly one block to
  // explain and the ambiguous-call refusal can be asserted first.
  const plc2Revised = blockXml({
    units: [
      unitXml(1, { parts: 1, wires: 1, accesses: 1, title: 'Only', text: 'a := 1;' }),
      unitXml(2, { parts: 1, wires: 1, accesses: 1, title: 'Also', text: 'a := 2;' }),
    ],
    inputMembers: [memberXml('A', 'Bool')],
    outputMembers: [],
    title: 'PLC2 block',
  }).replace('<Name>FC1</Name>', '<Name>FC2</Name>')
  await makeFile(join(root, 'source', 'PLC2', 'blocks', '020', 'FC2.xml'), plc2Revised)
  await commitAll(root, 'second')

  const ambiguous = await runDiff(t, root)
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.error.code, 'invalid_argument')
  assert.match(ambiguous.error.message, /holds 2 devices/u)
  assert.deepEqual(ambiguous.error.details.devices, ['PLC1', 'PLC2'])

  const chosen = await runDiff(t, root, { device: 'PLC2' })
  assert.equal(chosen.ok, true)
  assert.equal(chosen.data.device.device, 'PLC2')
  assert.equal(chosen.data.blocks[0].identity.name, 'FC2')
  assert.equal(chosen.data.blocks[0].units.added.count, 1)

  const unknown = await runDiff(t, root, { device: 'PLC9' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'invalid_argument')
  assert.match(unknown.error.message, /no device PLC9/u)
})

test('a composition without gitContext fails closed with git_access_unavailable', async (t) => {
  const root = await committedProject(t)
  const tools = diffToolFor(undefined)
  const missing = assertEnvelope(await executeTool(tools.diff, {}, fakeExec(root)))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'git_access_unavailable')
  assert.match(missing.error.message, /gitContext/u)
})

test('a workspace outside git is refused with repository_not_found', async (t) => {
  const root = await tempWorkspace(t)
  await writeDevice(root, { xml: baselineXml() })
  const outcome = await runDiff(t, root)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'repository_not_found')
  assert.match(outcome.error.message, /never creates a repository/u)
})

test('project_diff writes nothing: same HEAD, same porcelain, same files, and no commit', async (t) => {
  const root = await committedProject(t)
  const dirties = await porcelain(root)
  assert.equal(dirties, '')
  const beforeHead = await head(root)
  const beforeEntries = (await readdir(join(root, 'source', DEVICE), { recursive: true })).sort()
  const beforeEvidence = await readFile(join(root, 'source', DEVICE, '_evidence.json'), 'utf8')
  const { service, calls } = gitContextFor(root)

  const outcome = await runDiff(t, root, { to: 'WORKTREE', device: DEVICE }, { service })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.dryRun, true)

  assert.equal(await head(root), beforeHead, 'no commit may be created')
  assert.equal(await porcelain(root), dirties, 'the working tree must stay untouched')
  assert.deepEqual((await readdir(join(root, 'source', DEVICE), { recursive: true })).sort(), beforeEntries)
  assert.equal(await readFile(join(root, 'source', DEVICE, '_evidence.json'), 'utf8'), beforeEvidence)
  assert.deepEqual(
    calls.filter((call) => call.operation.startsWith('WRITE-')),
    [],
    'no write-shaped gitContext member may be called',
  )
  for (const call of calls) {
    if (call.operation !== 'run') continue
    assert.ok(
      ['rev-parse', 'diff', 'show', 'ls-files'].includes(call.args[0]),
      `project_diff must only run read-only git commands, saw: ${call.args.join(' ')}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Entry point and package surface
// ---------------------------------------------------------------------------

test('the diff entry registers exactly one tool; the main entry never registers it', async () => {
  const { ctx, definitions } = createTestContext()
  diffEntry.apply(ctx, {})
  assert.deepEqual(definitions.map((definition) => definition.name), [DIFF])
  assert.equal(definitions[0].description.includes('NOT available to the Auditor'), true)
  assert.equal(definitions[0].description.includes('Read-only'), true)

  const { ctx: mainCtx } = createTestContext()
  const main = toolDefinitions({ ctx: mainCtx, config: resolveConfig(), log: mainCtx.logger })
  assert.deepEqual(main.map((definition) => definition.name), [
    'create_engineering_project',
    'project_status',
    'project_sync',
  ])
  assert.equal(main.some((definition) => definition.name === DIFF), false)

  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.exports['./diff'], { default: './lib/diff-entry.js' })
  assert.equal(typeof pkg.dependencies['fast-xml-parser'], 'string')
})

test("the presets mount project_diff for Leader and Expert, never for the Auditor", async () => {
  // The preset lab in this repository is authored outside this package, so this
  // is a read-only guard: Leader/Expert may mount the diff entry, the Auditor
  // must not gain it by accident.
  const profilePath = join(packageRoot, '..', '..', 'profile', 'dsh-automation-suite', 'cordis.patch.yml')
  let yaml
  try {
    yaml = await readFile(profilePath, 'utf8')
  } catch {
    return // profile not materialized in this checkout; the entry check above stands
  }
  const leaderStart = yaml.indexOf('- id: preset-leader')
  const auditorStart = yaml.indexOf('- id: preset-auditor')
  const expertStart = yaml.indexOf('- id: preset-expert')
  assert.ok(leaderStart >= 0, 'the profile must declare the leader preset')
  assert.ok(auditorStart > leaderStart, 'the leader block precedes the auditor block')
  assert.ok(expertStart > auditorStart, 'the auditor block precedes the expert block')

  const diffRow = "@voltarenyah/dsh-engineering-context/diff"
  const leaderBlock = yaml.slice(leaderStart, auditorStart)
  assert.match(leaderBlock, /- id: leader-project-diff/u)
  assert.equal(leaderBlock.includes(diffRow), true, 'the Leader preset must mount the diff entry')

  const auditorBlock = yaml.slice(auditorStart, expertStart)
  assert.equal(
    /name:\s*'@voltarenyah\/dsh-engineering-context\/diff'/u.test(auditorBlock),
    false,
    'the Auditor preset must not mount the diff entry',
  )
  assert.equal(
    /name:\s*'@voltarenyah\/dsh-engineering-context'/u.test(
      auditorBlock.split('- id: auditor-tia-tools')[0] ?? auditorBlock,
    ),
    true,
    'the Auditor keeps its create/status/sync row',
  )

  const expertBlock = yaml.slice(expertStart)
  assert.match(expertBlock, /- id: expert-project-diff/u)
  assert.equal(expertBlock.includes(diffRow), true, 'the Expert preset must mount the diff entry')
})
