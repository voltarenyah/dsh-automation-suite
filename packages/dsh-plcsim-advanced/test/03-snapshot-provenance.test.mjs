import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools } from '../lib/tools.js'

/** A tool harness that records what the controller would be asked. */
function harness(options = {}) {
  const definitions = []
  const calls = []
  const ctx = { tools: { register(definition) { definitions.push(definition) } } }
  const dependencies = {
    verbose: false,
    status: () => ({ state: 'stopped' }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async request(operation, params) {
      calls.push({ operation, params })
      return {
        type: 'result',
        protocol: 1,
        id: '1',
        operation,
        ok: options.ok ?? true,
        data: options.data ?? { operation, params },
        error: options.error ?? null,
        durationMs: 3,
      }
    },
  }
  registerTools(ctx, dependencies)
  return { definitions, byName: new Map(definitions.map((d) => [d.name, d])), calls }
}

function exec(cwd) {
  return { signal: undefined, agent: { session: { header: { cwd } } } }
}

/** A workspace with the engineering-context index and one evidence ledger. */
async function managedWorkspace(checksum = 'CHECKSUM-A') {
  const workspace = await mkdtemp(join(tmpdir(), 'plcsim-provenance-'))
  const deviceDir = join(workspace, 'source', 'PLC_1')
  await mkdir(deviceDir, { recursive: true })
  const projectPath = join(workspace, 'tia', 'demo', 'demo.ap17')
  await mkdir(join(workspace, 'tia', 'demo'), { recursive: true })
  await writeFile(projectPath, 'project')
  await writeFile(
    join(workspace, 'source', '_dsh-engineering-context.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: 'demo', path: projectPath, savedAs: projectPath, archive: null },
      devices: [{ device: 'PLC_1', software: 'PLC_1', directory: deviceDir }],
    }),
  )
  await writeFile(
    join(deviceDir, '_evidence.json'),
    JSON.stringify({ plcChecksum: checksum, stateId: 'state-1' }),
  )
  return workspace
}

test('snapshot records the managed project and compiled checksum from the workspace', async () => {
  const workspace = await managedWorkspace('CHECKSUM-A')
  try {
    const { byName, calls } = harness()
    await byName.get('simulation_instance').execute(
      { action: 'snapshot', name: 'PLC_1', snapshot: 'baseline' },
      exec(workspace),
    )
    const params = calls[0].params
    assert.equal(params.action, 'snapshot')
    assert.equal(params.source_project, 'tia/demo/demo.ap17')
    assert.equal(params.source_project_name, 'demo')
    assert.equal(params.source_device, 'PLC_1')
    assert.equal(params.source_software, 'PLC_1')
    assert.equal(params.source_checksum, 'CHECKSUM-A')
    assert.equal(params.source_state_id, 'state-1')
    assert.match(params.source_captured_at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('an explicit checksum overrides the ledger and a missing ledger degrades to no fields', async () => {
  const workspace = await managedWorkspace('CHECKSUM-A')
  try {
    const { byName, calls } = harness()
    await byName.get('simulation_instance').execute(
      { action: 'snapshot', name: 'PLC_1', snapshot: 'baseline', source_checksum: 'EXPLICIT' },
      exec(workspace),
    )
    assert.equal(calls[0].params.source_checksum, 'EXPLICIT')

    const empty = await mkdtemp(join(tmpdir(), 'plcsim-empty-'))
    try {
      const second = harness()
      await second.byName.get('simulation_instance').execute(
        { action: 'snapshot', name: 'PLC_1', snapshot: 'baseline' },
        exec(empty),
      )
      assert.equal('source_checksum' in second.calls[0].params, false)
      assert.deepEqual(second.calls[0].params, {
        action: 'snapshot',
        name: 'PLC_1',
        snapshot: 'baseline',
        snapshot_root: join(empty, '.dsh', 'simulation'),
      })
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('snapshots are flagged stale against the current evidence ledger and rendered as text', async () => {
  const workspace = await managedWorkspace('NEW-CHECKSUM')
  try {
    const { byName } = harness({
      data: {
        snapshotRoot: join(workspace, '.dsh', 'simulation'),
        snapshots: [
          {
            snapshot: 'baseline',
            updatedAt: '2026-11-17T01:00:00Z',
            source: { checksum: 'OLD-CHECKSUM', device: 'PLC_1' },
          },
          {
            snapshot: 'current',
            updatedAt: '2026-11-17T02:00:00Z',
            source: { checksum: 'NEW-CHECKSUM', device: 'PLC_1' },
          },
        ],
      },
    })
    const value = await byName.get('simulation_status').execute({}, exec(workspace))
    assert.equal(value.data.snapshots[0].stale, true)
    assert.equal(value.data.snapshots[1].stale, false)

    const rendered = byName
      .get('simulation_status')
      .output.render({}, value)
      .map((block) => block.text)
      .join('\n')
    assert.match(rendered, /Snapshots:/)
    assert.match(rendered, /snapshot=baseline/)
    assert.match(rendered, /checksum=OLD-CHECKSUM/)
    assert.match(rendered, /stale=true/)
    assert.match(rendered, /snapshot=current/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('restore/resume carry the snapshot source and the stale flag', async () => {
  const workspace = await managedWorkspace('NEW-CHECKSUM')
  try {
    const { byName } = harness({
      data: {
        name: 'PLC_1',
        state: 'RUN',
        snapshot: 'baseline',
        source: { checksum: 'OLD-CHECKSUM', device: 'PLC_1' },
      },
    })
    const value = await byName.get('simulation_instance').execute(
      { action: 'resume', name: 'PLC_1', snapshot: 'baseline' },
      exec(workspace),
    )
    assert.equal(value.data.stale, true)
    const rendered = byName
      .get('simulation_instance')
      .output.render({ action: 'resume' }, value)
      .map((block) => block.text)
      .join('\n')
    assert.match(rendered, /checksum=OLD-CHECKSUM/)
    assert.match(rendered, /stale=true/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('snapshot_remove requires confirm and forwards only the snapshot name', async () => {
  const { byName, calls } = harness()
  const refused = await byName.get('simulation_instance').execute(
    { action: 'snapshot_remove', snapshot: 'baseline' },
    {},
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'confirmation_required')
  assert.equal(calls.length, 0)

  await byName.get('simulation_instance').execute(
    { action: 'snapshot_remove', snapshot: 'baseline', confirm: true },
    {},
  )
  assert.deepEqual(calls[0], {
    operation: 'Instance',
    params: { action: 'snapshot_remove', snapshot: 'baseline' },
  })
})

test('the snapshot_remove action is in the tool enum', () => {
  const { byName } = harness()
  const action = byName.get('simulation_instance').parameters.properties.action
  assert.equal(action.enum.includes('snapshot_remove'), true)
})
