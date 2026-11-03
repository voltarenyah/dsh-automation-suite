/**
 * Model tests: the view-file contract and the pure helpers the panel leans on.
 *
 * The producer is the TIA plugin's `hardware_view`; these tests pin down what the
 * renderer does with a well-formed view, with a half-written one, and with the
 * formatting rules the approved design depends on.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ROLE_ORDER,
  addressLabel,
  filterDevices,
  formatBytes,
  groupPaths,
  isFailsafe,
  moduleFace,
  parseView,
  shortSha,
  slotOf,
} from '../lib/model.js'

/** A minimal but complete view, shaped like the controller's output. */
function sample() {
  return {
    project: 'SWT2_PEI_1026_Night',
    generatedAt: '2026-11-03 12:35',
    aml: { path: 'C:\\ws\\hardware\\globalHardware.aml', bytes: 1470084, sha256: 'a'.repeat(64), schemaVersion: '2.15' },
    counts: { devices: 1, racks: 1, modules: 2, channels: { di: 4, do: 0, ai: 2, ao: 0, total: 6 } },
    content: { signals: 1, subnets: 1, nodes: 1 },
    networks: {
      subnets: [
        {
          name: 'PN/IE_1',
          type: 'Ethernet',
          nodes: [{ device: 'COF-BASE-A', interface: 'X1', ip: '192.168.1.10', subnetMask: '255.255.255.0', profinetName: 'cof-base-a' }],
        },
      ],
      ioSystems: [{ device: 'Sino_PEI', number: '100' }],
    },
    links: { port: 16, subnet: 17, ioSystem: 15 },
    devices: [
      {
        name: 'COF-BASE-A',
        groupPath: 'PEI_SinoARP/SubModule',
        role: 'io',
        typeIdentifier: 'System:Device.ET200SP',
        typeName: 'IM 155-6 PN/2 HF',
        orderNumber: '6ES7 155-6AU01-0CN0',
        firmware: 'V4.2',
        ip: '192.168.1.10',
        mask: '255.255.255.0',
        profinetName: 'cof-base-a',
        interface: 'X1',
        subnet: 'PN/IE_1',
        status: 'ok',
        kpis: { di: 4, do: 0, ai: 2, ao: 0, total: 6, modules: 2 },
        modules: [
          {
            slot: '0',
            name: 'COF-BASE-A',
            typeName: 'IM 155-6 PN/2 HF',
            orderNumber: '6ES7 155-6AU01-0CN0',
            firmware: 'V4.2',
            deviceItemType: 'HeadModule',
            channels: { di: 0, do: 0, ai: 0, ao: 0, total: 0 },
            addresses: [],
          },
          {
            slot: '1',
            name: '200MOD4',
            typeName: 'F-DI 8x24VDC HF',
            orderNumber: '6ES7 136-6BA01-0CA0',
            firmware: 'V2.0',
            deviceItemType: null,
            channels: { di: 8, do: 0, ai: 0, ao: 0, total: 8 },
            addresses: [{ ioType: 'Input', start: '1150', length: '72' }],
          },
        ],
        signals: [{ slot: '1', module: '200MOD4', channel: 'Channel_DI_0', tag: 'I_x', address: '32.6', dataType: 'Bool' }],
        tagSignals: [],
      },
      {
        name: 'HMI_1',
        groupPath: null,
        role: 'hmi',
        typeIdentifier: null,
        typeName: null,
        orderNumber: null,
        firmware: null,
        ip: '192.168.1.2',
        mask: null,
        profinetName: 'hmi_1',
        interface: null,
        subnet: 'PN/IE_1',
        status: 'missing',
        kpis: { di: 0, do: 0, ai: 0, ao: 0, total: 0, modules: 0 },
        modules: [],
        signals: [],
        tagSignals: [],
      },
    ],
  }
}

test('parseView reads the contract the producer writes', () => {
  const view = parseView(JSON.stringify(sample()))
  assert.notEqual(view, null)
  assert.equal(view.project, 'SWT2_PEI_1026_Night')
  assert.equal(view.counts.channels.total, 6)
  assert.equal(view.devices.length, 2)
  assert.equal(view.devices[0].modules.length, 2)
  assert.equal(view.devices[0].modules[1].addresses[0].start, '1150')
  assert.equal(view.networks.subnets[0].nodes[0].ip, '192.168.1.10')
  assert.equal(view.devices[1].status, 'missing')
})

test('the producer nests the project name under aml; both spellings parse', () => {
  const base = sample()
  const nested = { ...base, project: undefined, aml: { ...base.aml, project: 'PEI_SinoARP_SWT2' } }
  const view = parseView(JSON.stringify(nested))
  assert.notEqual(view, null)
  assert.equal(view.project, 'PEI_SinoARP_SWT2')
})

test('parseView refuses anything that is not a view', () => {
  assert.equal(parseView(''), null)
  assert.equal(parseView('not json'), null)
  assert.equal(parseView('[]'), null)
  assert.equal(parseView('{"devices":[]}'), null, 'a view needs a project name')
})

test('a half-written view still renders: missing members degrade to empty', () => {
  const view = parseView(JSON.stringify({ project: 'P', devices: [{ name: 'D' }] }))
  assert.notEqual(view, null)
  assert.equal(view.devices[0].role, 'other')
  assert.deepEqual(view.devices[0].modules, [])
  assert.equal(view.devices[0].kpis.modules, 0)
  assert.equal(view.aml.sha256, undefined)
})

test('roles are limited to the rail order', () => {
  const view = parseView(JSON.stringify({ project: 'P', devices: [{ name: 'D', role: 'plc' }] }))
  assert.equal(view.devices[0].role, 'other')
  assert.deepEqual([...ROLE_ORDER].slice(0, 2), ['controller', 'io'])
})

test('filterDevices searches device, model, MLFB and modules; group narrows it', () => {
  const view = parseView(JSON.stringify(sample()))
  assert.equal(filterDevices(view, '', null).length, 2)
  assert.deepEqual(filterDevices(view, 'cof-base', null).map((d) => d.name), ['COF-BASE-A'])
  assert.deepEqual(filterDevices(view, '6es7 136', null).map((d) => d.name), ['COF-BASE-A'], 'an MLFB found on a module matches')
  assert.deepEqual(filterDevices(view, '', 'PEI_SinoARP/SubModule').map((d) => d.name), ['COF-BASE-A'])
  assert.deepEqual(filterDevices(view, 'nothing-here', null), [])
  assert.deepEqual(groupPaths(view), ['PEI_SinoARP/SubModule'])
})

test('slotOf falls back to the first module, the way the sheet opens', () => {
  const view = parseView(JSON.stringify(sample()))
  const [device] = view.devices
  assert.equal(slotOf(device, '1').name, '200MOD4')
  assert.equal(slotOf(device, null).slot, '0')
  assert.equal(slotOf(device, '99').slot, '0', 'an unknown slot opens the first one')
  assert.equal(slotOf(view.devices[1], '0'), null, 'a device without modules has no slot')
})

test('the rack face reads like the printed label', () => {
  assert.equal(moduleFace({ name: 'COF-BASE-A', typeName: 'IM 155-6 PN/2 HF', deviceItemType: 'HeadModule' }), 'IM')
  assert.equal(moduleFace({ name: '200MOD9', typeName: 'F-RS 0.9 - 3A HF 3DI/LC', deviceItemType: null }), 'F-RS')
  assert.equal(moduleFace({ name: '200MOD8', typeName: 'BU-Cover 15 mm', deviceItemType: null }), 'BU')
  assert.equal(moduleFace({ name: '1200MOD2', typeName: null, deviceItemType: null }), 'MOD2')
  assert.equal(isFailsafe({ name: 'x', typeName: 'F-DI 8x24VDC HF' }), true)
  assert.equal(isFailsafe({ name: 'x', typeName: 'AI 4xRTD/TC' }), false)
})

test('address windows and metadata format as the design expects', () => {
  assert.equal(addressLabel({ ioType: 'Input', start: '1150', length: '72' }), 'Input 1150 +72')
  assert.equal(addressLabel({ ioType: null, start: null, length: null }), '—')
  assert.equal(shortSha('abcdef0123456789'), 'abcdef012345')
  assert.equal(shortSha(undefined), '—')
  assert.equal(formatBytes(1470084), '1.40 MB')
  assert.equal(formatBytes(undefined), '—')
})