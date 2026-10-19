/**
 * Pure core of the PLC Blocks tab: read a device manifest into flat rows, filter
 * and order them, and turn a workspace path into a resource address. No React,
 * no DOM, no network — this is the part the test suite drives directly.
 *
 * Why the manifest and not the directory tree: `simaticType` (`FB` / `FC` / `OB` /
 * `InstanceDB` / …) exists only in `_tia-openness-manifest.json`. The export's
 * folder layout says nothing about the type, so a type filter has to read the
 * manifest. The tree's folder hierarchy is deliberately dropped here: the tab
 * flattens every object into one list, which is what the user asked for.
 *
 * The manifest is written by another plugin (the TIA controller), so parsing is
 * defensive: a missing or mistyped field degrades a row, and a corrupt document
 * becomes `{ ok: false }` rather than an exception.
 *
 * @module dsh-ui-plc-source/model
 */

/** Directory the tab reads, relative to the session workspace root. */
export const SOURCE_DIRECTORY = 'source'

/** Per-device manifest file name, as the interface plugin writes it. */
export const MANIFEST_FILE = '_tia-openness-manifest.json'

/** Filter value meaning "no constraint". */
export const ALL = 'all'

/** Placeholder type for rows whose type the tree could not learn. */
export const UNKNOWN_TYPE = '未知'

/** Display order of the types this plugin knows about. */
export const TYPE_ORDER = [
  'OB',
  'FB',
  'FC',
  'InstanceDB',
  'GlobalDB',
  'ArrayDB',
  'PlcStruct',
  'PlcTagTable',
] as const

/** Which family an exported object belongs to. */
export type ObjectKind = 'block' | 'type' | 'tagTable' | 'file'

/** One flattened object, as the tab renders it. */
export interface SourceRow {
  /** Device (PLC) the object was exported from. */
  readonly device: string
  readonly kind: ObjectKind
  /** `FB`, `FC`, `InstanceDB`, … or `UNKNOWN_TYPE`. */
  readonly simaticType: string
  /** Object name: the declared name when the manifest has one. */
  readonly name: string
  /** Block/object number, when the manifest reports one. */
  readonly number?: string
  /** Programming language (`SCL`, `LAD`, …), when reported. */
  readonly language?: string
  /** Exported file size in bytes, when reported. */
  readonly bytes?: number
  /** Whether the write-then-read-back check passed. */
  readonly verified: boolean
  /** Absolute path of the exported file. */
  readonly file: string
  /** True for an object TIA refused to export: it has no file, only a reason. */
  readonly refused?: boolean
  /** Why TIA refused it (the manifest's failure `code`), for refused rows. */
  readonly reason?: string
}

/** One `blocks[]` entry as the manifest writes it (all fields optional: it is foreign JSON). */
export interface ManifestEntry {
  readonly name?: unknown
  readonly declaredName?: unknown
  readonly declaredNumber?: unknown
  readonly programmingLanguage?: unknown
  readonly simaticType?: unknown
  readonly category?: unknown
  readonly bytes?: unknown
  readonly verified?: unknown
  readonly file?: unknown
}

/** One `failures[]` entry: an object Openness refused to export. */
export interface ManifestFailure {
  readonly name?: unknown
  readonly group?: unknown
  readonly category?: unknown
  readonly file?: unknown
  readonly code?: unknown
  readonly message?: unknown
}

/** The parts of the manifest document this plugin reads. */
export interface Manifest {
  readonly blocks?: unknown
  readonly failures?: unknown
  readonly failureCount?: unknown
}

/** Result of turning manifest text into rows. */
export type ParsedManifest =
  | { readonly ok: true; readonly rows: readonly SourceRow[]; readonly failures: number }
  | { readonly ok: false; readonly code: string }

/** Non-string values that still make sense as text (the controller writes some numbers as strings). */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** @returns the object's family from the manifest's `category` field. */
export function kindOf(category: unknown): ObjectKind {
  switch (category) {
    case 'blocks':
      return 'block'
    case 'types':
      return 'type'
    case 'tag_tables':
      return 'tagTable'
    default:
      return 'file'
  }
}

/**
 * Parse one device's manifest text into flat rows.
 *
 * Objects TIA refused become rows too: they are absent from `blocks[]`, so
 * without them the list silently shows fewer objects than the export planned and
 * the user has no way to learn which ones are missing. They carry `refused` and a
 * reason instead of a usable file.
 *
 * @param text - the manifest file, decoded as UTF-8.
 * @param device - device name, stamped onto every row.
 * @returns rows plus the count of objects TIA refused to export, or a failure code.
 */
export function parseManifest(text: string, device: string): ParsedManifest {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, code: 'manifest/invalid' }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, code: 'manifest/invalid' }
  }
  const manifest = document as Manifest
  if (!Array.isArray(manifest.blocks)) {
    return { ok: false, code: 'manifest/invalid' }
  }
  const rows: SourceRow[] = []
  for (const item of manifest.blocks) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as ManifestEntry
    const file = textOf(entry.file) ?? ''
    const name = textOf(entry.declaredName) ?? textOf(entry.name) ?? (file.length > 0 ? fileName(file) : '')
    if (name.length === 0) continue
    rows.push({
      device,
      kind: kindOf(entry.category),
      simaticType: textOf(entry.simaticType) ?? UNKNOWN_TYPE,
      name,
      ...(textOf(entry.declaredNumber) === undefined ? {} : { number: textOf(entry.declaredNumber) }),
      ...(textOf(entry.programmingLanguage) === undefined
        ? {}
        : { language: textOf(entry.programmingLanguage) }),
      ...(typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) && entry.bytes >= 0
        ? { bytes: entry.bytes }
        : {}),
      verified: entry.verified !== false,
      file,
    })
  }
  if (Array.isArray(manifest.failures)) {
    for (const item of manifest.failures) {
      if (typeof item !== 'object' || item === null) continue
      const failure = item as ManifestFailure
      const file = textOf(failure.file) ?? ''
      const name = textOf(failure.name) ?? (file.length > 0 ? fileName(file) : '')
      if (name.length === 0) continue
      const reason = textOf(failure.message) ?? textOf(failure.code)
      rows.push({
        device,
        kind: kindOf(failure.category),
        simaticType: UNKNOWN_TYPE,
        name,
        refused: true,
        ...(reason === undefined ? {} : { reason }),
        verified: false,
        file,
      })
    }
  }
  const failures = Array.isArray(manifest.failures)
    ? manifest.failures.length
    : typeof manifest.failureCount === 'number' && Number.isFinite(manifest.failureCount)
      ? manifest.failureCount
      : 0
  return { ok: true, rows, failures }
}

/**
 * Position of a type in the display order; unknown types sort last.
 *
 * @param type - a `simaticType` value.
 * @returns the rank.
 */
export function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number])
  return index === -1 ? TYPE_ORDER.length : index
}

/**
 * Compare two names split into digit and non-digit runs: digit runs compare
 * numerically, everything else compares case-insensitively. Locale-independent
 * on purpose — the list must order the same way on every machine.
 *
 * @param left - first name.
 * @param right - second name.
 * @returns negative, zero or positive, ready for `Array.prototype.sort`.
 */
export function compareNatural(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/g) ?? [left]
  const rightParts = right.match(/\d+|\D+/g) ?? [right]
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const byValue = Number(a) - Number(b)
      if (byValue !== 0) return byValue
      const byLength = a.length - b.length
      if (byLength !== 0) return byLength
      continue
    }
    const byText = a.toLowerCase().localeCompare(b.toLowerCase(), 'en')
    if (byText !== 0) return byText
  }
  return 0
}

/**
 * Order rows the way the list reads: by type (fixed order), then by name.
 *
 * @param rows - flattened rows.
 * @returns a new array; the input is not mutated.
 */
export function sortRows(rows: readonly SourceRow[]): SourceRow[] {
  return [...rows].sort((left, right) => {
    const byType = typeRank(left.simaticType) - typeRank(right.simaticType)
    if (byType !== 0) return byType
    const byName = compareNatural(left.name, right.name)
    if (byName !== 0) return byName
    return compareNatural(left.device, right.device)
  })
}

/** One filter option and how many rows it would leave. */
export interface FilterOption {
  readonly value: string
  readonly count: number
}

/**
 * Stable identity of a row, used both as the React key and as the selection
 * value. The manifest has no cross-export object id (only name/group/type), so
 * this is the same composite key the rest of the pipeline falls back to; it is
 * unique within one export because two objects cannot share device, type, name
 * and number.
 *
 * @param row - one row.
 * @returns the identity string.
 */
export function rowKey(row: SourceRow): string {
  return [row.device, row.simaticType, row.name, row.number ?? '', row.refused === true ? 'refused' : 'exported'].join(
    '\u0000',
  )
}

/**
 * Devices present in the rows, with counts, in natural order.
 *
 * @param rows - flattened rows.
 * @returns the options, without an "all" entry.
 */
export function deviceOptions(rows: readonly SourceRow[]): FilterOption[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.device, (counts.get(row.device) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => compareNatural(left, right))
    .map(([value, count]) => ({ value, count }))
}

/**
 * Types present in the rows, with counts, in display order (unknown types last,
 * alphabetically).
 *
 * @param rows - flattened rows.
 * @returns the options, without an "all" entry.
 */
export function typeOptions(rows: readonly SourceRow[]): FilterOption[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.simaticType, (counts.get(row.simaticType) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => {
      const byRank = typeRank(left) - typeRank(right)
      return byRank !== 0 ? byRank : compareNatural(left, right)
    })
    .map(([value, count]) => ({ value, count }))
}

/**
 * Whether a row matches the free-text query. The query is case-insensitive and
 * matches anywhere in the object name or its number, so `scp` finds `SCP_IN`
 * and `1001` finds the block whose number is 1001.
 *
 * @param row - one row.
 * @param query - raw query text (empty matches everything).
 * @returns whether the row stays visible.
 */
export function matchesQuery(row: SourceRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (row.name.toLowerCase().includes(needle)) return true
  return row.number !== undefined && row.number.toLowerCase().includes(needle)
}

/**
 * Rows matching the type/device filters and the free-text query. `ALL` means "no
 * constraint"; the filter options are derived from all rows, so they never
 * shrink each other and the query does not remove choices either.
 *
 * @param rows - flattened rows.
 * @param device - device name or `ALL`.
 * @param type - `simaticType` or `ALL`.
 * @param query - free text matched against name and number (default: no query).
 * @returns the matching rows, in the given order.
 */
export function filterRows(
  rows: readonly SourceRow[],
  device: string,
  type: string,
  query = '',
): SourceRow[] {
  return rows.filter(
    (row) =>
      (device === ALL || row.device === device) &&
      (type === ALL || row.simaticType === type) &&
      matchesQuery(row, query),
  )
}

/** Separator a path already uses; '/' unless the path is a pure Windows path. */
function separatorOf(path: string): '/' | '\\' {
  if (path.includes('\\') && !path.includes('/')) return '\\'
  return '/'
}

/**
 * Append one path segment, keeping the separator style of the parent.
 *
 * @param parent - directory path (may be empty).
 * @param name - one segment, never containing a separator.
 * @returns the joined path.
 */
export function joinPath(parent: string, name: string): string {
  if (parent.length === 0) return name
  const last = parent.slice(-1)
  if (last === '/' || last === '\\') return parent + name
  return parent + separatorOf(parent) + name
}

/**
 * @param path - any path.
 * @returns the last segment, or the path itself when it has none.
 */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length === 0 ? path : (parts[parts.length - 1] ?? path)
}

/**
 * Path of `absolute` below `root`, with '/' separators, or null when it does not
 * live under `root`. Windows compares case-insensitively because the host may
 * report a different case than the session's cwd.
 *
 * @param root - the session workspace root (`cwd`).
 * @param absolute - a path taken from the manifest.
 * @returns the relative path, or null.
 */
export function relativeUnder(root: string, absolute: string): string | null {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = normalize(root)
  const target = normalize(absolute)
  if (base.length === 0) return target.replace(/^\/+/, '')
  if (target.length === base.length) return target.toLowerCase() === base.toLowerCase() ? '' : null
  if (target.length < base.length) return null
  if (target.charAt(base.length) !== '/') return null
  if (target.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return null
  return target.slice(base.length + 1)
}

/**
 * `dsh-resource://file/session/<session>/<relative path>` — the address the
 * document-preview tab claims, so a click reuses the shipped viewer instead of
 * growing one here. Each segment is encoded; the session is part of the address
 * because the host authorizes a file read through it.
 *
 * @param sessionId - the session the file belongs to.
 * @param relativePath - path relative to that session's workspace root.
 * @returns the resource address.
 */
export function resourceAddress(sessionId: string, relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`
}

/**
 * The locale key that explains a failure, plus the code it interpolates.
 *
 * The copy itself lives in the locale dictionaries rather than here: text held
 * by a pure module would be frozen at whatever language was active when it was
 * written, while a key resolved during render follows the app's language
 * setting. A missing `source/` is the normal state of a workspace that has not
 * run `create_engineering_project` yet, not an error.
 *
 * @param code - `RemoteError` code, or a transport code.
 * @returns the dictionary key to translate, and the code to pass for `{code}`.
 */
export function errorCopy(code: string): { readonly key: string; readonly code: string } {
  switch (code) {
    case 'workspace-file/not-found':
      return { key: 'error.notFound', code }
    case 'workspace-file/outside-workspace':
      return { key: 'error.outsideWorkspace', code }
    case 'workspace-file/not-directory':
      return { key: 'error.notDirectory', code }
    case 'workspace-file/not-regular-file':
      return { key: 'error.notRegularFile', code }
    case 'workspace-file/too-large':
      return { key: 'error.tooLarge', code }
    case 'workspace-file/not-text':
      return { key: 'error.notText', code }
    case 'workspace-file/watch-unsupported':
      return { key: 'error.watchUnsupported', code }
    case 'manifest/invalid':
      return { key: 'error.manifestInvalid', code }
    case 'gateway/cancelled':
      return { key: 'error.cancelled', code }
    case 'gateway/lookup-not-found':
      return { key: 'error.lookupNotFound', code }
    default:
      return { key: code.startsWith('gateway/') ? 'error.gateway' : 'error.other', code }
  }
}

/**
 * @param bytes - reported size, when the host reports one.
 * @returns a short human size, or an empty string when the size is unknown.
 */
export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}
