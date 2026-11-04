/**
 * Import preflight: decide, before TIA touches the project, which files an
 * `import_blocks` call is likely to refuse and why.
 *
 * Why it exists: a TIA import runs as one transaction. The first file it cannot
 * accept rolls the whole batch back and reports one reason; the operator then
 * fixes, retries and discovers the next reason. A real cross-project import
 * (SWT2 → SWT1, 2026-11-04) failed three times in a row for three different
 * reasons — a multilingual text culture the target project does not have, a
 * UDT imported before the UDT it references, and (a false alarm) block numbers.
 * The first two are visible in the XML and in the target project before the
 * transaction starts; this module reports them.
 *
 * What it deliberately does **not** check:
 *
 *   - **Block numbers.** TIA assigns them on import; a number collision in the
 *     source project is not a conflict in the target (measured: the operator
 *     corrected this assumption in the same session). Names are the identity.
 *   - **Calls inside networks.** Following FB/FC calls through LAD/SCL networks
 *     is the knowledge graph's job, not a string scan's. A missing called block
 *     surfaces as TIA's own refusal.
 *   - **Hardware.** Missing servo axes, F-DQ/F-DI channels and safety programs
 *     are engineering gaps; a static check cannot judge them, and pretending to
 *     would be worse than saying nothing.
 *
 * @module dsh-engineering-context/preflight
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

/** The object families a preflight distinguishes. */
export type PreflightKind = 'block' | 'type' | 'tag_table' | 'unknown'

/** One parsed Simatic ML file. */
export interface PreflightObject {
  path: string
  kind: PreflightKind
  /** Root element of the exported object, e.g. `SW.Blocks.FB`. */
  xmlRoot: string | null
  /** True for an instance DB (its parent FB must exist first). */
  instanceDb: boolean
  name: string | null
  number: string | null
  /** Every culture a multilingual text item carries. */
  cultures: string[]
  /** Non-primitive datatypes and `InstanceOfName` values this object needs. */
  dependencies: string[]
  instanceOf: string | null
  /** Why the file could not be parsed, or null. */
  error: string | null
}

/** One finding, blocking or advisory. */
export interface PreflightIssue {
  code: string
  /** `kind:name`, or the file path when no name could be read. */
  object: string | null
  message: string
  fix: string
}

/** The structured result of one preflight. */
export interface PreflightReport {
  objects: PreflightObject[]
  blocking: PreflightIssue[]
  warnings: PreflightIssue[]
  /** Import order this preflight recommends, as absolute paths. */
  suggestedOrder: string[]
  stats: {
    files: number
    parsed: number
    unparsed: number
    blocks: number
    types: number
    tagTables: number
    blocking: number
    warnings: number
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'Member' || name === 'Section' || name === 'MultilingualTextItem',
})

/** Datatypes that are not a dependency on another object. */
const PRIMITIVE =
  /^(Bool|Byte|Word|DWord|SInt|Int|DInt|USInt|UInt|UDInt|LInt|ULInt|Real|LReal|Time|S5Time|LTime|Date|TOD|LTOD|DTL|LDT|Char|WChar|String|WString|Struct|Void|Pointer|Any|Variant|ErrorStruct|S7ANY|HW_[A-Z_]+|Event_[A-Z_]+)$/iu

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Walk every node and hand each `[key, value]` pair to the visitor. */
function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit)
    return
  }
  const node = record(value)
  if (node === null) return
  for (const [key, entry] of Object.entries(node)) {
    // Repeatable children are arrays; the visitor wants one element at a time
    // (that is how `Member`, `Section` and `MultilingualTextItem` are declared).
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(key, item)
        walk(item, visit)
      }
    } else {
      visit(key, entry)
      walk(entry, visit)
    }
  }
}

/** Strip the quotes and array suffixes Simatic ML puts around datatype names. */
export function normalizeDatatype(raw: string): string | null {
  let value = raw.trim()
  if (value.length === 0) return null
  value = value.replace(/^"+|"+$/gu, '').trim()
  if (value.length === 0) return null
  const of = /\bof\s+(.+)$/iu.exec(value)
  if (of !== null && of[1] !== undefined) value = of[1].trim().replace(/^"+|"+$/gu, '')
  value = value.replace(/\[[^\]]*\]/gu, '').trim()
  return value.length === 0 ? null : value
}

/** Whether a datatype names a user object rather than a built-in. */
export function isDependencyDatatype(datatype: string): boolean {
  const value = normalizeDatatype(datatype)
  return value !== null && !PRIMITIVE.test(value)
}

function kindOf(root: string | null): PreflightKind {
  if (root === null) return 'unknown'
  if (root.startsWith('SW.Types.')) return 'type'
  if (root.startsWith('SW.Tags.PlcTagTable')) return 'tag_table'
  if (/^SW\.Blocks\./u.test(root)) return 'block'
  return 'unknown'
}

/**
 * Parse one Simatic ML file.
 *
 * A malformed file is returned with `error` set and `kind: 'unknown'`: the
 * preflight reports it instead of dropping it, because a file that cannot be
 * parsed will also be refused by TIA (usually with a less useful message).
 *
 * @param path - absolute file path.
 * @returns the parsed object, tolerant of every shape problem.
 */
export async function parseXmlFile(path: string): Promise<PreflightObject> {
  const base: PreflightObject = {
    path,
    kind: 'unknown',
    xmlRoot: null,
    instanceDb: false,
    name: null,
    number: null,
    cultures: [],
    dependencies: [],
    instanceOf: null,
    error: null,
  }

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    return { ...base, error: `cannot be read: ${error instanceof Error ? error.message : String(error)}` }
  }

  let document: unknown
  try {
    document = parser.parse(raw)
  } catch (error) {
    return { ...base, error: `is not valid XML: ${error instanceof Error ? error.message : String(error)}` }
  }

  const top = record(document)
  if (top === null) return { ...base, error: 'has no XML root element' }
  // A Simatic ML export wraps the object in a `<Document>` element; the object
  // itself is the `SW.*` child. Accept a bare `SW.*` root as well, because some
  // hand-trimmed fixtures pass one.
  const documentBody = record(top['Document']) ?? top
  const rootKey = Object.keys(documentBody).find((key) => key.startsWith('SW.')) ?? null
  if (rootKey === null) return { ...base, error: 'is not Simatic ML (no SW.* root element)' }

  const root = record(documentBody[rootKey])
  const attributeList = record(root?.['AttributeList'])
  const name = text(attributeList?.['Name'])
  const number = text(attributeList?.['Number'])

  const cultures = new Set<string>()
  const dependencies = new Set<string>()
  let instanceOf: string | null = null

  if (root !== null) {
    walk(root, (key, value) => {
      if (key === 'MultilingualTextItem') {
        const item = record(value)
        const attributes = record(item?.['AttributeList'])
        const culture = text(attributes?.['Culture'])
        if (culture !== null) cultures.add(culture)
      }
      if (key === 'InstanceOfName') {
        const name = text(value)
        if (name !== null) instanceOf = name
      }
      if (key === 'Member') {
        const member = record(value)
        const datatype = text(member?.['@_Datatype'])
        if (datatype !== null && isDependencyDatatype(datatype)) {
          const normalized = normalizeDatatype(datatype)
          if (normalized !== null) dependencies.add(normalized)
        }
      }
    })
  }

  const kind = kindOf(rootKey)
  const instanceDb = rootKey === 'SW.Blocks.InstanceDB' || rootKey === 'SW.Blocks.ArrayDB'
  return {
    ...base,
    kind,
    xmlRoot: rootKey,
    instanceDb,
    name,
    number,
    cultures: [...cultures].sort(),
    dependencies: [...dependencies].sort(),
    instanceOf,
    error: null,
  }
}

/** Files to preflight, plus what was left out and why. */
export interface ExpandedPaths {
  files: string[]
  warnings: string[]
}

/** Expand the caller's files/directories into the XML files to inspect. */
export async function expandImportPaths(
  paths: readonly string[],
  cwd: string | undefined,
  maxFiles = 500,
): Promise<ExpandedPaths> {
  const files = new Set<string>()
  const warnings: string[] = []

  const collect = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      warnings.push(`${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await collect(absolute)
      else if (entry.isFile() && absolute.toLowerCase().endsWith('.xml')) files.add(absolute)
    }
  }

  for (const spelled of paths) {
    const absolute = isAbsolute(spelled) ? spelled : join(cwd ?? '.', spelled)
    let info
    try {
      info = await stat(absolute)
    } catch {
      warnings.push(`${spelled} does not exist.`)
      continue
    }
    if (info.isDirectory()) await collect(absolute)
    else if (info.isFile()) {
      if (absolute.toLowerCase().endsWith('.xml')) files.add(absolute)
      else warnings.push(`${spelled} is not a Simatic ML XML file, so it is not checked.`)
    }
  }

  const all = [...files].sort((left, right) => left.localeCompare(right))
  if (all.length > maxFiles) {
    warnings.push(
      `Only the first ${maxFiles} of ${all.length} XML files are checked; split the import into smaller batches for a full check.`,
    )
  }
  return { files: all.slice(0, maxFiles), warnings }
}

/** The read-only target facts the caller gathered from TIA, if any. */
export interface PreflightTarget {
  projectName: string | null
  /** Active language cultures, lower-cased, or null when unknown. */
  activeLanguages: string[] | null
  /** `category:name`, lower-cased, for every object the target already has. */
  existing: Set<string> | null
  /** True when the target listing was capped, so the name check may miss objects. */
  listingTruncated: boolean
}

function keyOf(kind: PreflightKind, name: string): string {
  return `${kind === 'block' ? 'blocks' : kind === 'type' ? 'types' : kind === 'tag_table' ? 'tag_tables' : 'unknown'}:${name.toLowerCase()}`
}

/** Topologically order the type objects by their type dependencies. */
function orderTypes(types: readonly PreflightObject[]): PreflightObject[] {
  const remaining = [...types]
  const ordered: PreflightObject[] = []
  const done = new Set<string>()
  while (remaining.length > 0) {
    const next = remaining.findIndex((entry) => {
      if (entry.name === null) return true
      return entry.dependencies.every((dependency) => {
        const dependencyInBatch = remaining.some(
          (candidate) => candidate.name !== null && candidate.name.toLowerCase() === dependency.toLowerCase(),
        )
        if (!dependencyInBatch) return true
        return done.has(dependency.toLowerCase())
      })
    })
    // A cycle would leave no candidate; keep the original order and move on.
    const index = next === -1 ? 0 : next
    const entry = remaining.splice(index, 1)[0]
    if (entry !== undefined) {
      ordered.push(entry)
      if (entry.name !== null) done.add(entry.name.toLowerCase())
    }
  }
  return ordered
}

/**
 * Build the report from parsed objects and the target facts.
 *
 * @param objects - parsed files, in the order they were handed in.
 * @param target - the target project facts, or null when TIA was not available.
 * @returns the report; `blocking` is what will certainly fail, `warnings` is
 *   what may fail or could not be checked.
 */
export function buildPreflight(objects: readonly PreflightObject[], target: PreflightTarget | null): PreflightReport {
  const blocking: PreflightIssue[] = []
  const warnings: PreflightIssue[] = []
  const active =
    target?.activeLanguages === null || target?.activeLanguages === undefined
      ? null
      : new Set(target.activeLanguages.map((culture) => culture.toLowerCase()))
  const activeDisplay =
    target?.activeLanguages === null || target?.activeLanguages === undefined
      ? 'none'
      : target.activeLanguages.join(', ')

  const batchNames = new Map<string, PreflightObject[]>()
  for (const entry of objects) {
    const key = entry.name === null ? null : keyOf(entry.kind, entry.name)
    if (key === null) continue
    const list = batchNames.get(key) ?? []
    list.push(entry)
    batchNames.set(key, list)
  }
  const batchBlockNames = new Set(
    objects.filter((entry) => entry.kind === 'block' && entry.name !== null).map((entry) => entry.name!.toLowerCase()),
  )
  const batchTypeNames = new Set(
    objects.filter((entry) => entry.kind === 'type' && entry.name !== null).map((entry) => entry.name!.toLowerCase()),
  )
  const label = (entry: PreflightObject): string => (entry.name === null ? entry.path : `${entry.kind}:${entry.name}`)

  for (const entry of objects) {
    if (entry.error !== null) {
      warnings.push({
        code: 'unparsable',
        object: entry.path,
        message: `${entry.path} ${entry.error}.`,
        fix: 'Fix or remove the file before importing; TIA would refuse it with a less specific error.',
      })
      continue
    }
    if (entry.kind === 'unknown') {
      warnings.push({
        code: 'unknown_object',
        object: label(entry),
        message: `${entry.path} has the root element ${entry.xmlRoot ?? '(none)'}, which this preflight does not classify.`,
        fix: 'Check the file is a Simatic ML export of a block, PLC type or tag table.',
      })
      continue
    }

    if (active !== null) {
      const unsupported = entry.cultures.filter((culture) => !active.has(culture.toLowerCase()))
      if (unsupported.length > 0) {
        blocking.push({
          code: 'language_not_active',
          object: label(entry),
          message:
            `${label(entry)} carries multilingual text in ${unsupported.join(', ')}, which the target project does not have ` +
            `activated (active: ${activeDisplay}). TIA refuses the whole import transaction.`,
          fix: 'Remove the empty text items in those cultures from a staged copy, or activate the languages in the target project.',
        })
      }
    }

    if (entry.name !== null) {
      const duplicates = batchNames.get(keyOf(entry.kind, entry.name)) ?? []
      if (duplicates.length > 1) {
        blocking.push({
          code: 'duplicate_in_batch',
          object: label(entry),
          message: `${label(entry)} appears ${duplicates.length} times in this batch (${duplicates.map((item) => item.path).join(', ')}).`,
          fix: 'Keep one file per object name; remove the duplicates.',
        })
      }
      if (target?.existing !== null && target?.existing !== undefined && target.existing.has(keyOf(entry.kind, entry.name))) {
        blocking.push({
          code: 'name_exists',
          object: label(entry),
          message: `${label(entry)} already exists in the target project. TIA refuses "An object with this name or this number already exists".`,
          fix: 'Pass import_options=override AND the same target_group the existing object lives in, or import under a different name.',
        })
      }
    }

    for (const dependency of entry.dependencies) {
      const lower = dependency.toLowerCase()
      const inBatch = batchBlockNames.has(lower) || batchTypeNames.has(lower)
      const inTarget =
        target?.existing !== null &&
        target?.existing !== undefined &&
        (target.existing.has(`blocks:${lower}`) || target.existing.has(`types:${lower}`))
      if (!inBatch && !inTarget) {
        warnings.push({
          code: 'dependency_unresolved',
          object: label(entry),
          message: `${label(entry)} references ${dependency}, which is in neither this batch nor the target project's listing.`,
          fix: 'Import the dependency first, or confirm it is a system/DriveLib type TIA resolves by itself.',
        })
      }
    }

    if (entry.instanceOf !== null) {
      const lower = entry.instanceOf.toLowerCase()
      const parentInBatch = batchBlockNames.has(lower)
      const parentInTarget =
        target?.existing !== null && target?.existing !== undefined && target.existing.has(`blocks:${lower}`)
      if (!parentInBatch && !parentInTarget) {
        warnings.push({
          code: 'instance_parent_missing',
          object: label(entry),
          message: `${label(entry)} is an instance of ${entry.instanceOf}, which is in neither this batch nor the target project.`,
          fix: `Import ${entry.instanceOf} first.`,
        })
      }
    }
  }

  // A type that is imported after the type it references fails with
  // "Data type ... is unknown" even though both files are in the batch.
  const batches = objects
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.kind === 'type' && item.entry.name !== null)
  for (const { entry, index } of batches) {
    const name = entry.name as string
    for (const dependency of entry.dependencies) {
      const dependencyEntry = batches.find(
        (item) => (item.entry.name as string).toLowerCase() === dependency.toLowerCase(),
      )
      if (dependencyEntry === undefined) continue
      if (dependencyEntry.index > index) {
        warnings.push({
          code: 'type_order',
          object: `type:${name}`,
          message: `type:${name} references ${dependencyEntry.entry.name} but appears after it in the batch.`,
          fix: 'Follow suggestedOrder: import the referenced type first.',
        })
        break
      }
    }
  }

  if (target?.listingTruncated === true) {
    warnings.push({
      code: 'target_listing_truncated',
      object: null,
      message: 'The target project listing was capped, so the "already exists" check may have missed objects.',
      fix: 'Re-run the preflight with a larger max_items, or check the names in TIA.',
    })
  }

  const types = orderTypes(
    objects.filter((entry) => entry.kind === 'type' && entry.error === null),
  )
  const blocks = objects.filter((entry) => entry.kind === 'block' && !entry.instanceDb && entry.error === null)
  const instanceDbs = objects.filter((entry) => entry.kind === 'block' && entry.instanceDb && entry.error === null)
  const tagTables = objects.filter((entry) => entry.kind === 'tag_table' && entry.error === null)
  const rest = objects.filter(
    (entry) => entry.error !== null || (entry.kind === 'unknown' && entry.error === null),
  )
  const suggestedOrder = [...types, ...blocks, ...instanceDbs, ...tagTables, ...rest].map((entry) => entry.path)

  return {
    objects: [...objects],
    blocking,
    warnings,
    suggestedOrder,
    stats: {
      files: objects.length,
      parsed: objects.filter((entry) => entry.error === null).length,
      unparsed: objects.filter((entry) => entry.error !== null).length,
      blocks: objects.filter((entry) => entry.kind === 'block').length,
      types: objects.filter((entry) => entry.kind === 'type').length,
      tagTables: objects.filter((entry) => entry.kind === 'tag_table').length,
      blocking: blocking.length,
      warnings: warnings.length,
    },
  }
}
