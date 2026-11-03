// Builds the standalone hardware page from real tool output.
//
// Inputs (produced by the controller, no TIA needed):
//   inventory.json      controller --operation HardwareInventory
//   configuration.json  controller --operation HardwareConfiguration
//
// Output: hardware.html — one self-contained file with the data inlined, so it
// can be opened directly and compared in a sidebar-width pane and full width.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** The two tool dumps are not committed (they are regenerable). */
function load(name) {
  const file = join(here, name)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    console.error(
      `missing ${name}. Produce it with the controller first (no TIA needed):\n\n` +
        `  controller\\bin\\TiaOpennessV17Min.Controller.exe --operation HardwareInventory \\\n` +
        `    --params-json '{"aml_path":"<path to globalHardware.aml>"}' > ${name}\n`,
    )
    process.exit(2)
  }
}

const inventory = load('inventory.json')
const configuration = load('configuration.json')

if (!inventory.ok || !configuration.ok) {
  throw new Error(`tool output is not ok: inventory=${inventory.ok} configuration=${configuration.ok}`)
}

const inv = inventory.data
const cfg = configuration.data

/** F parameter values measured with hardware_parameters on 2026-11-02. */
const F_MEASURED = {
  'COF-BASE-A': {
    slot: '3',
    module: '200MOD4',
    note: 'F-DI 8x24VDC HF (6ES7 136-6BA01-0CA0)',
    values: [
      ['Failsafe_FSIL', '2', 'Read'],
      ['Failsafe_FMonitoringtime', '150', 'ReadWrite'],
      ['Failsafe_FSourceAddress', '1', 'Read'],
      ['Failsafe_FDestinationAddress', '65530', 'ReadWrite'],
      ['Failsafe_FPassivation', '1', 'Read'],
      ['Failsafe_F_CRC_Length', '2', 'Read'],
      ['Failsafe_FIODBNumber', '30009', 'Read'],
      ['Failsafe_DIPSwitchSetting', '1111111010', 'Read'],
      ['Failsafe_ShortCircuitTest_7', 'true', 'ReadWrite'],
    ],
  },
  'COF-BASE-A_1': {
    slot: '3',
    module: '200MOD4',
    note: 'F-DI 8x24VDC HF (6ES7 136-6BA01-0CA0)',
    values: [
      ['Failsafe_FSIL', '2', 'Read'],
      ['Failsafe_FMonitoringtime', '150', 'ReadWrite'],
      ['Failsafe_FDestinationAddress', '65528', 'ReadWrite'],
      ['Failsafe_FPassivation', '1', 'Read'],
      ['Failsafe_F_CRC_Length', '2', 'Read'],
      ['Failsafe_DIPSwitchSetting', '1111111000', 'Read'],
    ],
  },
  'ET 200SP_1': {
    slot: '3',
    module: '200MOD4',
    note: 'F-DQ 4x24VDC/2A PM HF (6ES7 136-6DB00-0CA0)',
    values: [
      ['Failsafe_FSIL', '2', 'Read'],
      ['Failsafe_FMonitoringtime', '150', 'ReadWrite'],
      ['Failsafe_FSourceAddress', '1', 'Read'],
      ['Failsafe_FDestinationAddress', '65534', 'ReadWrite'],
      ['Failsafe_FPassivation', '1', 'Read'],
      ['Failsafe_F_CRC_Length', '0', 'Read'],
      ['Failsafe_FIODBNumber', '30004', 'Read'],
      ['Failsafe_DisableDarkTestMaxSIL2_CAT3_PLd', 'false', 'ReadWrite'],
    ],
  },
}

/** Nodes carry the network identity; a device can own more than one (X1/X2). */
const nodesByDevice = new Map()
for (const node of cfg.network.nodes ?? []) {
  if (!nodesByDevice.has(node.device)) nodesByDevice.set(node.device, [])
  nodesByDevice.get(node.device).push(node)
}

/** Node→subnet membership comes from the InternalLink set, not from an attribute. */
const subnetByDevice = new Map()
for (const link of cfg.links ?? []) {
  if (link.kind !== 'node-subnet') continue
  const nodeSide = link.sideA.device === link.sideB.device ? link.sideA : (link.sideA.interface === 'LogicalEndPoint_Node' ? link.sideA : link.sideB)
  const subnetSide = nodeSide === link.sideA ? link.sideB : link.sideA
  if (nodeSide.interface !== 'LogicalEndPoint_Node') continue
  if (!subnetByDevice.has(nodeSide.device)) subnetByDevice.set(nodeSide.device, new Set())
  subnetByDevice.get(nodeSide.device).add(subnetSide.element)
}

/** Address groups per device+slot, so a slot chip can show its I/O window. */
const addressesBySlot = new Map()
for (const a of cfg.addresses ?? []) {
  const key = `${a.device}|${a.slot}`
  if (!addressesBySlot.has(key)) addressesBySlot.set(key, [])
  addressesBySlot.get(key).push({ ioType: a.ioType, start: a.startAddress, length: a.length })
}

/** "System:Device.SinamicsV90PN" -> "SinamicsV90PN", "GSD:….XML/D" -> "GSD device".
 *  A device whose head module carries no TypeName still needs something readable. */
function prettify(typeIdentifier) {
  if (!typeIdentifier) return null
  if (typeIdentifier.startsWith('GSD:')) return typeIdentifier.match(/\/([^/]+)$/)?.[1] ?? 'GSD device'
  const tail = typeIdentifier.split('.').pop() ?? typeIdentifier
  return tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}
/** Role drives the device rail's grouping: the same question ("what is this?")
 *  is answered first, before the model number. */
function roleOf(device) {
  const id = device.typeIdentifier ?? ''
  if (/System:Device\.S7/.test(id)) return 'controller'
  if (/ET200/.test(id)) return 'io'
  if (/Sinamics|SV660|UNIDRIVE|InnoDrive|110A2/.test(id)) return 'drive'
  if (/Scalance/i.test(id)) return 'network'
  if (id.startsWith('GSD:')) return 'thirdParty'
  return 'other'
}
/** Signals are keyed by the device that owns the channel, not the tag's device. */
const signalsByDevice = new Map()
for (const signal of cfg.signals ?? []) {
  const device = signal.channel.device
  if (!signalsByDevice.has(device)) signalsByDevice.set(device, [])
  signalsByDevice.get(device).push({
    slot: signal.channel.slot,
    module: signal.channel.module,
    channel: signal.channel.channel,
    tag: signal.tag.name,
    address: signal.tag.logicalAddress,
    dataType: signal.tag.dataType,
  })
}

/** Signals whose *tag* lives on this device: the controller side of the mapping. */
const tagSignalsByDevice = new Map()
for (const signal of cfg.signals ?? []) {
  const device = signal.tag.device
  if (!tagSignalsByDevice.has(device)) tagSignalsByDevice.set(device, [])
  tagSignalsByDevice.get(device).push({
    slot: signal.channel.slot,
    module: signal.channel.module,
    channel: signal.channel.channel,
    tag: signal.tag.name,
    address: signal.tag.logicalAddress,
    dataType: signal.tag.dataType,
  })
}

const devices = (inv.devices ?? []).map((device) => {
  const modules = (device.racks ?? []).flatMap((rack) => rack.modules ?? [])
  const kpis = modules.reduce(
    (acc, m) => {
      const c = m.channels ?? {}
      acc.di += c.di ?? 0
      acc.do += c.do ?? 0
      acc.ai += c.ai ?? 0
      acc.ao += c.ao ?? 0
      return acc
    },
    { di: 0, do: 0, ai: 0, ao: 0 },
  )
  const nodes = nodesByDevice.get(device.name) ?? []
  const first = nodes[0]
  const f = F_MEASURED[device.name]
  // A device carries no TypeName of its own; the human name and the MLFB live on
  // its head module (slot 0, DeviceItemType HeadModule).
  const head = modules.find((m) => m.deviceItemType === 'HeadModule') ?? modules.find((m) => m.deviceItemType === 'CPU') ?? modules[0] ?? null
  return {
    name: device.name,
    groupPath: device.groupPath ?? '',
    roleClass: device.roleClass ?? null,
    typeIdentifier: device.typeIdentifier ?? null,
    typeName: head?.typeName ?? prettify(device.typeIdentifier),
    orderNumber: head?.orderNumber ?? null,
    firmware: head?.firmwareVersion ?? null,
    ip: first?.ip ?? null,
    mask: first?.subnetMask ?? null,
    profinetName: first?.profinetName ?? null,
    interface: nodes.map((n) => n.interface).filter(Boolean).join(' · ') || null,
    subnet: [...(subnetByDevice.get(device.name) ?? [])].join(' · ') || null,
    additionalNodes: nodes.length > 1 ? nodes.length - 1 : 0,
    status: 'ok',
    role: roleOf(device),
    hasF: modules.some((m) => (m.typeName ?? '').startsWith('F-')),
    isGsd: (device.typeIdentifier ?? '').startsWith('GSD:'),
    kpis: { ...kpis, modules: modules.length },
    modules: modules.map((m) => ({
      slot: m.slot ?? null,
      name: m.name,
      typeName: m.typeName ?? null,
      orderNumber: m.orderNumber ?? null,
      firmware: m.firmwareVersion ?? null,
      deviceItemType: m.deviceItemType ?? null,
      channels: m.channels ?? null,
      addresses: addressesBySlot.get(`${device.name}|${m.slot}`) ?? [],
    })),
    signals: signalsByDevice.get(device.name) ?? [],
    tagSignals: tagSignalsByDevice.get(device.name) ?? [],
    f: f
      ? [{ slot: f.slot, module: f.module, note: f.note, values: f.values.map(([name, value, access]) => ({ name, value, access })) }]
      : [],
  }
})

/** The one device CAx refused to export — present in the project, absent from the AML. */
devices.push({
  name: 'HMI_1',
  groupPath: '',
  roleClass: 'Device',
  typeIdentifier: null,
  typeName: 'HMI (type not exported)',
  orderNumber: null,
  firmware: null,
  ip: '192.168.1.2',
  mask: null,
  profinetName: 'hmi_1',
  interface: null,
  subnet: 'PN/IE_1',
  additionalNodes: 0,
  status: 'missing',
  role: 'hmi',
  reason: 'device HMI_1 is being skipped. The required attribute TypeIdentifier is invalid or missing.',
  hasF: false,
  isGsd: false,
  kpis: { di: 0, do: 0, ai: 0, ao: 0, modules: 0 },
  modules: [],
  signals: [],
  tagSignals: [],
  f: [],
})

const linkCounts = { port: 0, subnet: 0, ioSystem: 0 }
for (const link of cfg.links ?? []) {
  if (link.kind === 'port-port') linkCounts.port++
  else if (link.kind === 'node-subnet') linkCounts.subnet++
  else if (link.kind === 'interface-iosystem') linkCounts.ioSystem++
}

const subnetNames = new Set((cfg.network.subnets ?? []).map((s) => s.name))
const model = {
  lang: 'zh',
  project: inv.aml?.project ?? 'project',
  generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  aml: {
    path: inv.aml?.path ?? '',
    bytes: inv.aml?.bytes ?? 0,
    sha256: inv.aml?.sha256 ?? '',
    schemaVersion: inv.aml?.schemaVersion ?? '',
  },
  counts: {
    devices: devices.filter((d) => d.status === 'ok').length,
    racks: inv.counts?.racks ?? 0,
    modules: inv.counts?.modules ?? 0,
    channels: inv.counts?.channels ?? { di: 0, do: 0, ai: 0, ao: 0, total: 0 },
  },
  content: {
    signals: (cfg.signals ?? []).length,
    tags: (cfg.tags ?? []).length,
    addresses: (cfg.addresses ?? []).length,
    subnets: (cfg.network.subnets ?? []).length,
    nodes: (cfg.network.nodes ?? []).length,
  },
  networks: {
    subnets: [...subnetNames].map((name) => ({
      name,
      type: (cfg.network.subnets ?? []).find((s) => s.name === name)?.type ?? null,
      nodes: (cfg.network.nodes ?? [])
        .filter((n) => (subnetByDevice.get(n.device) ?? new Set()).has(name))
        .map((n) => ({ device: n.device, interface: n.interface, ip: n.ip, mask: n.subnetMask, pnName: n.profinetName })),
    })),
    ioSystems: (cfg.network.ioSystems ?? []).map((s) => ({ device: s.device, number: s.number, interface: s.interface })),
  },
  links: linkCounts,
  devices,
}

const template = readFileSync(join(here, 'page.tpl.html'), 'utf8')
const html = template.replace('/*__DATA__*/null', JSON.stringify(model))
writeFileSync(join(here, 'hardware.html'), html, 'utf8')

const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`wrote hardware.html (${kb} KB) — ${model.counts.devices} devices, ${model.counts.modules} modules, ` +
  `${model.content.signals} signals, ${model.networks.subnets.length} subnets`)
