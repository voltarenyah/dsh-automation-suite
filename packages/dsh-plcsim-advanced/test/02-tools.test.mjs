import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../lib/tools.js'

function harness() {
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
    async request(operation, params) {
      calls.push({ operation, params })
      return {
        type: 'result',
        protocol: 1,
        id: '1',
        operation,
        ok: true,
        data: { operation, params },
        error: null,
        durationMs: 3,
      }
    },
  }
  registerTools(ctx, dependencies)
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  return { definitions, byName, calls }
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
