/**
 * The view file's shape, and the pure helpers the panel needs.
 *
 * The producer is the TIA plugin's `hardware_view` tool (`HardwareView` operation),
 * which parses the CAx/AML export once and writes the joined model. This module is
 * the rendering side of that contract: it parses defensively, filters, and formats —
 * no I/O, so the tests can drive it directly.
 *
 * @module dsh-ui-hardware/model
 */

/** Where the producer writes the view, relative to the workspace root. */
export const VIEW_FILE = '.dsh/hardware-view.json'

/** Device classes the rail groups by, in rail order. */
export const ROLE_ORDER = ['controller', 'io', 'drive', 'thirdParty', 'network', 'hmi', 'other'] as const

export type Role = (typeof ROLE_ORDER)[number]

/** One module inside a rack. */
export interface HardwareModule {
  readonly slot: string | null
  readonly name: string
  readonly typeName: string | null
  readonly orderNumber: string | null
  readonly firmware: string | null
  readonly deviceItemType: string | null
  readonly channels: ChannelCounts | null
  readonly addresses: readonly AddressWindow[]
}

/** An I/O address group of one module. */
export interface AddressWindow {
  readonly ioType: string | null
  readonly start: string | null
  readonly length: string | null
}

/** Chatacter counts by direction. */
export interface ChannelCounts {
  readonly di: number
  readonly do: number
  readonly ai: number
  readonly ao: number
  readonly total: number
}

/** One channel-to-tag mapping, flattened. */
export interface SignalRow {
  readonly slot?: string
  readonly module?: string
  readonly channel?: string
  readonly tag?: string
  readonly address?: string
  readonly dataType?: string
}

/** One device, with everything the sheet renders. */
export interface HardwareDevice {
  readonly name: string
  readonly groupPath: string | null
  readonly role: Role
  readonly typeIdentifier: string | null
  readonly typeName: string | null
  readonly orderNumber: string | null
  readonly firmware: string | null
  readonly ip: string | null
  readonly mask: string | null
  readonly profinetName: string | null
  readonly interface: string | null
  readonly subnet: string | null
  readonly status: 'ok' | 'missing'
  readonly kpis: ChannelCounts & { readonly modules: number }
  readonly modules: readonly HardwareModule[]
  readonly signals: readonly SignalRow[]
  readonly tagSignals: readonly SignalRow[]
}

/** A subnet with its member nodes. */
export interface Subnet {
  readonly name: string
  readonly type: string | null
  readonly nodes: readonly {
    readonly device?: string
    readonly interface?: string
    readonly ip?: string
    readonly subnetMask?: string
    readonly profinetName?: string
  }[]
}

/** The whole view. */
export interface HardwareView {
  readonly project: string
  readonly generatedAt: string
  readonly aml: {
    readonly path?: string
    readonly bytes?: number
    readonly sha256?: string
    readonly schemaVersion?: string
  }
  readonly counts: {
    readonly devices: number
    readonly racks: number
    readonly modules: number
    readonly channels: ChannelCounts
  }
  readonly content: {
    readonly signals: number
    readonly subnets: number
    readonly nodes: number
  }
  readonly networks: {
    readonly subnets: readonly Subnet[]
    readonly ioSystems: readonly { readonly device?: string; readonly number?: string }[]
  }
  readonly links: { readonly port: number; readonly subnet: number; readonly ioSystem: number }
  readonly devices: readonly HardwareDevice[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function counts(value: unknown): ChannelCounts {
  const raw = record(value)
  return {
    di: num(raw?.['di']),
    do: num(raw?.['do']),
    ai: num(raw?.['ai']),
    ao: num(raw?.['ao']),
    total: num(raw?.['total']),
  }
}

function addresses(value: unknown): AddressWindow[] {
  return list(value).flatMap((item) => {
    const raw = record(item)
    if (raw === null) return []
    return [{ ioType: str(raw['ioType']), start: str(raw['start']) ?? str(raw['startAddress']), length: str(raw['length']) }]
  })
}

function modules(value: unknown): HardwareModule[] {
  return list(value).flatMap((item) => {
    const raw = record(item)
    if (raw === null) return []
    const name = str(raw['name'])
    if (name === null) return []
    return [
      {
        slot: str(raw['slot']),
        name,
        typeName: str(raw['typeName']),
        orderNumber: str(raw['orderNumber']),
        firmware: str(raw['firmware']),
        deviceItemType: str(raw['deviceItemType']),
        channels: raw['channels'] === undefined ? null : counts(raw['channels']),
        addresses: addresses(raw['addresses']),
      },
    ]
  })
}

function role(value: unknown): Role {
  const text = str(value)
  return (ROLE_ORDER as readonly string[]).includes(text ?? '') ? (text as Role) : 'other'
}

function signals(value: unknown): SignalRow[] {
  return list(value).flatMap((item) => {
    const raw = record(item)
    if (raw === null) return []
    return [
      {
        slot: str(raw['slot']) ?? undefined,
        module: str(raw['module']) ?? undefined,
        channel: str(raw['channel']) ?? undefined,
        tag: str(raw['tag']) ?? undefined,
        address: str(raw['address']) ?? undefined,
        dataType: str(raw['dataType']) ?? undefined,
      },
    ]
  })
}

function devices(value: unknown): HardwareDevice[] {
  return list(value).flatMap((item) => {
    const raw = record(item)
    if (raw === null) return []
    const name = str(raw['name'])
    if (name === null) return []
    const kpis = record(raw['kpis'])
    const base = counts(kpis)
    return [
      {
        name,
        groupPath: str(raw['groupPath']),
        role: role(raw['role']),
        typeIdentifier: str(raw['typeIdentifier']),
        typeName: str(raw['typeName']),
        orderNumber: str(raw['orderNumber']),
        firmware: str(raw['firmware']),
        ip: str(raw['ip']),
        mask: str(raw['mask']),
        profinetName: str(raw['profinetName']),
        interface: str(raw['interface']),
        subnet: str(raw['subnet']),
        status: raw['status'] === 'missing' ? 'missing' : 'ok',
        kpis: { ...base, modules: num(kpis?.['modules']) },
        modules: modules(raw['modules']),
        signals: signals(raw['signals']),
        tagSignals: signals(raw['tagSignals']),
      },
    ]
  })
}

/**
 * Parse one view file.
 *
 * Tolerant on purpose: a malformed or half-written file must render an empty panel
 * with a reason, never throw inside a React tree.
 *
 * @param text - raw file contents.
 * @returns the parsed view, or `null` when the payload is not a view.
 */
export function parseView(text: string): HardwareView | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const raw = record(parsed)
  if (raw === null) return null
  const aml = record(raw['aml'])
  const countsRaw = record(raw['counts'])
  const content = record(raw['content'])
  const networks = record(raw['networks'])
  const links = record(raw['links'])
  // The producer nests it under ml (the header block); accept both spellings.
  const project = str(raw['project']) ?? str(aml?.['project'])
  if (project === null) return null

  const subnets = list(networks?.['subnets']).flatMap((item) => {
    const entry = record(item)
    const name = str(entry?.['name'])
    if (entry === null || name === null) return []
    const nodes = list(entry['nodes']).flatMap((node) => {
      const n = record(node)
      if (n === null) return []
      return [
        {
          device: str(n['device']) ?? undefined,
          interface: str(n['interface']) ?? undefined,
          ip: str(n['ip']) ?? undefined,
          subnetMask: str(n['subnetMask']) ?? undefined,
          profinetName: str(n['profinetName']) ?? undefined,
        },
      ]
    })
    return [{ name, type: str(entry['type']), nodes }]
  })

  return {
    project,
    generatedAt: str(raw['generatedAt']) ?? '—',
    aml: {
      path: str(aml?.['path']) ?? undefined,
      bytes: typeof aml?.['bytes'] === 'number' ? (aml['bytes'] as number) : undefined,
      sha256: str(aml?.['sha256']) ?? undefined,
      schemaVersion: str(aml?.['schemaVersion']) ?? undefined,
    },
    counts: {
      devices: num(countsRaw?.['devices']),
      racks: num(countsRaw?.['racks']),
      modules: num(countsRaw?.['modules']),
      channels: counts(countsRaw?.['channels']),
    },
    content: {
      signals: num(content?.['signals']),
      subnets: num(content?.['subnets']),
      nodes: num(content?.['nodes']),
    },
    networks: {
      subnets,
      ioSystems: list(networks?.['ioSystems']).flatMap((item) => {
        const entry = record(item)
        if (entry === null) return []
        return [{ device: str(entry['device']) ?? undefined, number: str(entry['number']) ?? undefined }]
      }),
    },
    links: { port: num(links?.['port']), subnet: num(links?.['subnet']), ioSystem: num(links?.['ioSystem']) },
    devices: devices(raw['devices']),
  }
}

/** Distinct user-group paths, sorted — the group filter's options. */
export function groupPaths(view: HardwareView): string[] {
  const seen = new Set<string>()
  for (const device of view.devices) if (device.groupPath !== null) seen.add(device.groupPath)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/**
 * Devices matching the toolbar's search and group filter.
 *
 * @param view - parsed view.
 * @param query - free text; matched against name, model, MLFB and every module.
 * @param group - a `groupPath` to keep, or `null` for all.
 * @returns the matching devices, in file order.
 */
export function filterDevices(view: HardwareView, query: string, group: string | null): HardwareDevice[] {
  const needle = query.trim().toLowerCase()
  return view.devices.filter((device) => {
    if (group !== null && device.groupPath !== group) return false
    if (needle.length === 0) return true
    const haystack = [
      device.name,
      device.orderNumber ?? '',
      device.typeName ?? '',
      device.ip ?? '',
      device.profinetName ?? '',
      ...device.modules.map((m) => `${m.name} ${m.orderNumber ?? ''} ${m.typeName ?? ''}`),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * The module the sheet should show for a slot selection.
 *
 * @param device - the station sheet's device.
 * @param slot - the selected slot, or `null`.
 * @returns the module, or `null` for a device without modules.
 */
export function slotOf(device: HardwareDevice, slot: string | null): HardwareModule | null {
  if (device.modules.length === 0) return null
  if (slot === null) return device.modules[0] ?? null
  return device.modules.find((m) => m.slot === slot) ?? device.modules[0] ?? null
}

/**
 * The face printed on a rack cell: the module's function, then its physical name.
 *
 * `IM` for a head module, otherwise the first token of the type name — shortened
 * when the token is long (`BU-Cover` → `BU`), but kept whole when it already reads
 * as a function (`F-RS`).
 *
 * @param module - one module.
 * @returns the short face label.
 */
export function moduleFace(module: HardwareModule): string {
  if (module.deviceItemType === 'HeadModule') return 'IM'
  const token = (module.typeName ?? '').split(/[\s,]+/)[0] ?? ''
  if (token.length === 0) return module.name.replace(/^\d+MOD/, 'MOD')
  const shortened = token.length > 7 ? (token.split('-')[0] ?? token) : token
  return shortened.toUpperCase()
}

/** True when the module is a failsafe one (its type name starts with `F-`). */
export function isFailsafe(module: HardwareModule): boolean {
  return (module.typeName ?? '').startsWith('F-')
}

/**
 * Format one address group for display: `Input 1150 +72`.
 *
 * @param window - one address group.
 * @returns a compact label, or `—` when the module has no address.
 */
export function addressLabel(window: AddressWindow): string {
  const parts = [window.ioType ?? '', window.start ?? ''].filter((part) => part.length > 0).join(' ')
  const length = window.length === null ? '' : ` +${window.length}`
  return parts.length === 0 ? '—' : `${parts}${length}`
}

/** Shorten a checksum for the footer. */
export function shortSha(sha: string | undefined): string {
  if (sha === undefined || sha.length === 0) return '—'
  return sha.slice(0, 12)
}

/** Format a byte count as MB with two decimals. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '—'
  return `${(bytes / 1048576).toFixed(2)} MB`
}