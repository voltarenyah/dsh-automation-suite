import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../lib/tools.js'

function harness(options = {}) {
  const definitions = []
  const calls = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
      },
    },
  }
  const dependencies = {
    verbose: false,
    status: () => ({ state: 'stopped' }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...(options.configuredSnapshotRoot === undefined
      ? {}
      : { configuredSnapshotRoot: options.configuredSnapshotRoot }),
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
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  return { definitions, byName, calls }
}

/** The execution identity a live tool call carries: the session workspace. */
function exec(cwd) {
  return { signal: undefined, agent: { session: { header: { cwd } } } }
}

test('registers exactly the four runtime tools', () => {
  const { definitions } = harness()
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['simulation_status', 'simulation_instance', 'simulation_run', 'simulation_tags'],
  )
})

test('simulation_status sends Status and renders the outcome', async () => {
  const { byName, calls } = harness()
  const result = await byName.get('simulation_status').execute({}, {})
  assert.deepEqual(calls, [{ operation: 'Status', params: {} }])
  assert.equal(result.ok, true)
  assert.equal(result.operation, 'Status')
  assert.match(result.summary, /Status completed/)
})

test('simulation_instance lists by default and forwards create', async () => {
  const { byName, calls } = harness()
  await byName.get('simulation_instance').execute({}, {})
  await byName.get('simulation_instance').execute({ action: 'create', name: 'PLC_1' }, {})
  assert.deepEqual(calls[0], { operation: 'Instance', params: { action: 'list' } })
  assert.deepEqual(calls[1], { operation: 'Instance', params: { action: 'create', name: 'PLC_1' } })
})

test('simulation_instance forwards the TCP/IP coordinates for the download workflow', async () => {
  const { byName, calls } = harness()
  await byName.get('simulation_instance').execute(
    {
      action: 'create',
      name: 'plc_1.profinet interface_1',
      cpu_type: '1511',
      communication: 'tcpip',
      ip: '192.168.0.1',
      subnet_mask: '255.255.255.0',
      gateway: '192.168.0.254',
    },
    {},
  )
  await byName.get('simulation_instance').execute(
    { action: 'power_on', name: 'plc_1.profinet interface_1', ip: '192.168.0.1' },
    {},
  )
  assert.deepEqual(calls[0], {
    operation: 'Instance',
    params: {
      action: 'create',
      name: 'plc_1.profinet interface_1',
      cpu_type: '1511',
      communication: 'tcpip',
      ip: '192.168.0.1',
      subnet_mask: '255.255.255.0',
      gateway: '192.168.0.254',
    },
  })
  assert.deepEqual(calls[1], {
    operation: 'Instance',
    params: { action: 'power_on', name: 'plc_1.profinet interface_1', ip: '192.168.0.1' },
  })
})

test('simulation_instance forwards the F-CPU family and the project CPU model', async () => {
  const { byName, calls } = harness()
  const create = byName.get('simulation_instance')
  await create.execute(
    { action: 'create', name: 'Sino_PEI', cpu_type: '1515F', communication: 'tcpip', ip: '192.168.1.1' },
    {},
  )
  await create.execute(
    { action: 'create', name: 'Sino_PEI_2', cpu_model: '6ES7 515-2FM01-0AB0', communication: 'tcpip', ip: '192.168.1.1' },
    {},
  )
  assert.deepEqual(calls[0], {
    operation: 'Instance',
    params: { action: 'create', name: 'Sino_PEI', cpu_type: '1515F', communication: 'tcpip', ip: '192.168.1.1' },
  })
  assert.deepEqual(calls[1], {
    operation: 'Instance',
    params: { action: 'create', name: 'Sino_PEI_2', cpu_model: '6ES7 515-2FM01-0AB0', communication: 'tcpip', ip: '192.168.1.1' },
  })
  assert.match(create.description, /F-CPU/)
  assert.match(create.description, /cpu_model/)
})

test('simulation_instance forwards snapshot and restore actions', async () => {
  const { byName, calls } = harness()
  await byName.get('simulation_instance').execute(
    { action: 'snapshot', name: 'PLC_1', snapshot: 'before-change', overwrite: true },
    {},
  )
  await byName.get('simulation_instance').execute(
    { action: 'restore', name: 'PLC_2', snapshot: 'before-change', run: true },
    {},
  )
  await byName.get('simulation_instance').execute(
    { action: 'resume', name: 'PLC_2', snapshot: 'before-change', run: true, fast: true },
    {},
  )
  assert.deepEqual(calls[0], {
    operation: 'Instance',
    params: {
      action: 'snapshot',
      name: 'PLC_1',
      snapshot: 'before-change',
      overwrite: true,
    },
  })
  assert.deepEqual(calls[1], {
    operation: 'Instance',
    params: {
      action: 'restore',
      name: 'PLC_2',
      snapshot: 'before-change',
      run: true,
    },
  })
  assert.deepEqual(calls[2], {
    operation: 'Instance',
    params: {
      action: 'resume',
      name: 'PLC_2',
      snapshot: 'before-change',
      run: true,
      fast: true,
    },
  })
})

test('simulation_instance refuses power_off/remove without confirm and sends nothing', async () => {
  const { byName, calls } = harness()
  const result = await byName.get('simulation_instance').execute({ action: 'remove', name: 'PLC_1' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'confirmation_required')
  assert.equal(calls.length, 0)
})

test('simulation_run refuses run/stop/reset without confirm and forwards state', async () => {
  const { byName, calls } = harness()
  const refused = await byName.get('simulation_run').execute({ action: 'run', name: 'PLC_1' }, {})
  assert.equal(refused.ok, false)
  assert.equal(calls.length, 0)

  await byName.get('simulation_run').execute({ action: 'state', name: 'PLC_1' }, {})
  await byName.get('simulation_run').execute({ action: 'run', name: 'PLC_1', confirm: true }, {})
  assert.deepEqual(calls[0], { operation: 'Run', params: { action: 'state', name: 'PLC_1' } })
  assert.deepEqual(calls[1], { operation: 'Run', params: { action: 'run', name: 'PLC_1' } })
})

test('simulation_tags lists by default, reads, and requires confirm for write', async () => {
  const { byName, calls } = harness()
  await byName.get('simulation_tags').execute({ name: 'PLC_1' }, {})
  await byName.get('simulation_tags').execute(
    { action: 'read', name: 'PLC_1', tag: '"DB".tag' },
    {},
  )
  const refused = await byName.get('simulation_tags').execute(
    { action: 'write', name: 'PLC_1', tag: '"DB".tag', value: true },
    {},
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'confirmation_required')
  assert.equal(calls.length, 2)

  await byName.get('simulation_tags').execute(
    { action: 'write', name: 'PLC_1', tag: '"DB".tag', value: true, confirm: true },
    {},
  )
  assert.deepEqual(calls[2], {
    operation: 'Tags',
    params: { action: 'write', name: 'PLC_1', tag: '"DB".tag', value: true },
  })
})

test('the snapshot root follows the session workspace, not the host process cwd', async () => {
  const { byName, calls } = harness()
  const workspace = process.platform === 'win32' ? 'C:\\ws\\demo' : '/ws/demo'
  await byName.get('simulation_status').execute({}, exec(workspace))
  await byName.get('simulation_instance').execute({ action: 'snapshot', name: 'PLC_1' }, exec(workspace))
  const expected = workspace + (process.platform === 'win32' ? '\\.dsh\\simulation' : '/.dsh/simulation')
  assert.deepEqual(calls[0].params, { snapshot_root: expected })
  assert.equal(calls[1].params.snapshot_root, expected)
})

test('an explicit snapshotRoot configuration wins over the workspace', async () => {
  const shared = process.platform === 'win32' ? 'D:\\shared\\sim' : '/shared/sim'
  const { byName, calls } = harness({ configuredSnapshotRoot: shared })
  await byName.get('simulation_status').execute({}, exec('/ws/demo'))
  assert.deepEqual(calls[0].params, { snapshot_root: shared })
})

test('a call without a session workspace sends no snapshot_root at all', async () => {
  const { byName, calls } = harness()
  await byName.get('simulation_status').execute({}, {})
  await byName.get('simulation_status').execute({}, { agent: {} })
  assert.deepEqual(calls, [
    { operation: 'Status', params: {} },
    { operation: 'Status', params: {} },
  ])
})

test('simulation_instance exposes the snapshots action and forwards confirm_new', async () => {
  const { byName, calls } = harness()
  const definition = byName.get('simulation_instance')
  assert.equal(definition.parameters.properties.action.enum.includes('snapshots'), true)
  await definition.execute({ action: 'snapshots' }, {})
  await definition.execute({ action: 'create', name: 'PLC_1', confirm_new: true }, {})
  assert.deepEqual(calls[0], { operation: 'Instance', params: { action: 'snapshots' } })
  assert.deepEqual(calls[1], {
    operation: 'Instance',
    params: { action: 'create', name: 'PLC_1', confirm_new: true },
  })
})

test('the certificate rule is stated in every tool description', () => {
  const { definitions, byName } = harness()
  for (const definition of definitions) {
    assert.match(definition.description, /certificate/i, `${definition.name} omits the certificate rule`)
    assert.match(definition.description, /snapshots/i, `${definition.name} omits the snapshot scan rule`)
    assert.match(definition.description, /workspace/i, `${definition.name} omits the workspace snapshot path`)
  }
  const create = byName.get('simulation_instance').description
  assert.match(create, /confirm_new=true/)
  assert.match(create, /<workspace>\/\.dsh\/simulation/)
})

test('a successful call renders the key facts even with verbose off', async () => {
  const { byName } = harness({
    data: {
      name: 'PLC_1',
      state: 'STOP',
      cpuType: 'CPU1515F',
      comm: 'TCPIP',
      ip: '192.168.1.50',
      snapshotRoot: 'C:\\ws\\demo\\.dsh\\simulation',
      snapshots: [{ snapshot: 'plc1-first-run', state: 'RUN' }],
    },
  })
  const value = await byName.get('simulation_instance').execute({ action: 'list' }, {})
  const rendered = byName
    .get('simulation_instance')
    .output.render({ action: 'list' }, value)
    .map((block) => block.text)
    .join('\n')
  assert.match(rendered, /Key facts:/)
  assert.match(rendered, /name=PLC_1/)
  assert.match(rendered, /cpuType=CPU1515F/)
  assert.match(rendered, /snapshots=plc1-first-run/)
})

test('a refusal still renders its error code and the choices to offer the user', async () => {
  const { byName } = harness({
    ok: false,
    data: null,
    error: {
      code: 'snapshots_available',
      message: 'This workspace already has 1 PLCSIM snapshot(s): plc1-first-run. Ask the user first.',
    },
  })
  const value = await byName.get('simulation_instance').execute({ action: 'create', name: 'PLC_2' }, {})
  const rendered = byName
    .get('simulation_instance')
    .output.render({ action: 'create', name: 'PLC_2' }, value)
    .map((block) => block.text)
    .join('\n')
  assert.match(rendered, /FAILED/)
  assert.match(rendered, /snapshots_available/)
  assert.match(rendered, /Ask the user first/)
})
