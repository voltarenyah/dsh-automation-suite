/**
 * Structural revision diff for one device's exported Simatic ML.
 *
 * `project_diff` is the *explanation* tool: the sync tools say **that** a block
 * changed (the evidence ledger records four face fingerprints and a content
 * hash), this module says **what** changed inside it — which compile units were
 * added, removed or altered, how many Parts/Wires/Accesses a changed unit gained
 * or lost, which interface members appeared or changed datatype, and which
 * multilingual text items are new or gone.
 *
 * Three rules shape the implementation:
 *
 *   1. **No TIA.** Everything comes from the source tree on disk plus git: the
 *      device directory is found through the index or the ledgers, never through
 *      the controller (docs/decisions.md D10/D12).
 *   2. **No writes.** `project_diff` only runs read-only git commands
 *      (`rev-parse`, `diff`, `show`, `ls-files`), reads files, and parses text.
 *      Nothing is staged, checked out or cached on disk.
 *   3. **Bounded.** The result is counts plus the first N entries, never the XML
 *      and never a whole file list. A block whose XML is unreasonably large is
 *      reported as `skipped` instead of parsed.
 *
 * XML is parsed with `fast-xml-parser` in `preserveOrder` mode: element order is
 * part of Simatic ML's meaning (network order is program order), and the
 * attribute-preserving mode keeps TIA's own IDs, which is how a unit is matched
 * across revisions.
 *
 * @module dsh-engineering-context/diff
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import type { Context } from '@deepseek-ai/cordis'

import { EVIDENCE_FILE, sourceDirectoryPath, sourceIndexPath, type PluginConfig } from './config.js'
import { EngineeringContextError } from './errors.js'
import { parseEvidenceDocument, type EvidenceDocument, type EvidenceObject } from './evidence.js'
import { gitContextService, type GitContextLike } from './git-context.js'
import { canonicalizeLoose, folderName, isInside, toPortable } from './paths.js'

/** The revision spelling that means "the working tree, uncommitted changes included". */
export const WORKTREE = 'WORKTREE'

/** Default `from` revision: the commit before the one being inspected. */
export const DIFF_DEFAULT_FROM = 'HEAD~1'

/** Default `to` revision: the repository state the workspace is on. */
export const DIFF_DEFAULT_TO = 'HEAD'

/** Default number of entries listed per list. Counts are always exact. */
export const DIFF_DEFAULT_MAX_ITEMS = 10

/** Upper bound a caller may raise `max_items` to. */
export const DIFF_MAX_ITEMS = 50

/**
 * Largest XML document this tool parses in one go.
 *
 * Exported blocks are typically tens to hundreds of KB; a multi-megabyte file is
 * almost certainly something other than Simatic ML, so it is reported as skipped
 * rather than parsed into a result the pruner would truncate anyway.
 */
export const DIFF_MAX_XML_CHARS = 4_000_000

// ---------------------------------------------------------------------------
// Device resolution (no TIA)
// ---------------------------------------------------------------------------

/** The device directory one diff call works on. */
export interface DiffDevice {
  /** Device name as the export recorded it. */
  device: string
  /** Software name, when the index knows it. */
  software: string | null
  /** Absolute, canonical device directory (inside `<workspace>/source/`). */
  directory: string
  /** Absolute canonical source root. */
  sourceRoot: string
  /** Where the device list came from. */
  resolvedFrom: 'index' | 'evidence'
}

interface IndexEntry {
  device?: unknown
  software?: unknown
  directory?: unknown
}

/** Devices the creation index records (`source/_dsh-engineering-context.json`). */
async function indexDevices(config: PluginConfig, root: string, sourceRoot: string): Promise<DiffDevice[]> {
  let raw: string
  try {
    raw = await readFile(sourceIndexPath(config, root), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const devices = (parsed as { devices?: unknown }).devices
  if (!Array.isArray(devices)) return []

  const found: DiffDevice[] = []
  for (const value of devices) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as IndexEntry
    const device = typeof entry.device === 'string' ? entry.device.trim() : ''
    if (device.length === 0) continue
    const recorded = typeof entry.directory === 'string' && entry.directory.length > 0 ? entry.directory : null
    let directory: string
    if (recorded !== null) {
      const absolute = isAbsolute(recorded) ? recorded : join(sourceRoot, recorded)
      const candidate = await canonicalizeLoose(absolute)
      // A recorded absolute path may point at another workspace after a move or
      // copy. It is a hint, not authority (same rule as `device.ts`).
      directory = isInside(sourceRoot, candidate)
        ? candidate
        : await canonicalizeLoose(join(sourceRoot, folderName(device)))
    } else {
      directory = await canonicalizeLoose(join(sourceRoot, folderName(device)))
    }
    const software = typeof entry.software === 'string' && entry.software.length > 0 ? entry.software : null
    found.push({ device, software, directory, sourceRoot, resolvedFrom: 'index' })
  }
  return found
}

/** Devices discovered by scanning `source/*` for `_evidence.json`. */
async function evidenceDevices(sourceRoot: string): Promise<DiffDevice[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const found: DiffDevice[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = await canonicalizeLoose(join(sourceRoot, entry.name))
    try {
      const evidence = await stat(join(directory, EVIDENCE_FILE))
      if (!evidence.isFile()) continue
    } catch {
      continue
    }
    found.push({
      device: entry.name,
      software: null,
      directory,
      sourceRoot,
      resolvedFrom: 'evidence',
    })
  }
  return found
}

/** Keep the first device per directory, preferring the index's spelling. */
function dedupeDevices(candidates: readonly DiffDevice[]): DiffDevice[] {
  const seen = new Map<string, DiffDevice>()
  for (const candidate of candidates) {
    const key = candidate.directory.toLowerCase()
    if (!seen.has(key)) seen.set(key, candidate)
  }
  return [...seen.values()].sort((left, right) => left.device.localeCompare(right.device))
}

/**
 * Resolve which device directory this call reads.
 *
 * The index is authoritative when present; otherwise a directory containing
 * `_evidence.json` is the mark of an exported device. More than one candidate and
 * no explicit `device` is refused instead of guessed: analysing the wrong PLC
 * would produce a confidently wrong explanation.
 *
 * @param config - the resolved configuration.
 * @param root - the canonical workspace root.
 * @param requested - the optional `device` argument.
 * @returns the device directory and how it was found.
 * @throws {EngineeringContextError} `device_not_found` when there is no candidate,
 *   `invalid_argument` when the choice is ambiguous or the named device is absent.
 */
export async function resolveDiffDevice(
  config: PluginConfig,
  root: string,
  requested?: string,
): Promise<DiffDevice> {
  const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(config, root))
  const candidates = dedupeDevices([
    ...(await indexDevices(config, root, sourceRoot)),
    ...(await evidenceDevices(sourceRoot)),
  ])

  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted.length > 0) {
    const lower = wanted.toLowerCase()
    const match = candidates.find(
      (candidate) =>
        candidate.device.toLowerCase() === lower ||
        basename(candidate.directory).toLowerCase() === lower ||
        folderName(candidate.device).toLowerCase() === lower,
    )
    if (match === undefined) {
      throw new EngineeringContextError(
        'invalid_argument',
        `This workspace has no device ${wanted}. Known devices: ${
          candidates.length === 0 ? '(none — export the project first)' : candidates.map((entry) => entry.device).join(', ')
        }.`,
        { requested: wanted, devices: candidates.map((entry) => entry.device) },
      )
    }
    return match
  }

  if (candidates.length === 0) {
    throw new EngineeringContextError(
      'device_not_found',
      `No device directory with an ${EVIDENCE_FILE} ledger was found under ${toPortable(root, sourceRoot)}/. Run create_engineering_project or project_sync first, or pass device explicitly.`,
      { sourceRoot },
    )
  }
  if (candidates.length > 1) {
    throw new EngineeringContextError(
      'invalid_argument',
      `This workspace holds ${candidates.length} devices (${candidates
        .map((entry) => entry.device)
        .join(', ')}); pass device to choose one. project_diff never guesses which PLC to analyse.`,
      { devices: candidates.map((entry) => entry.device) },
    )
  }
  const only = candidates[0]
  if (only === undefined) {
    throw new EngineeringContextError('device_not_found', `No device directory was found under ${toPortable(root, sourceRoot)}/.`, {
      sourceRoot,
    })
  }
  return only
}

// ---------------------------------------------------------------------------
// Revisions and read-only git plumbing
// ---------------------------------------------------------------------------

/** The git context bound to the workspace repository, with the requested spellings. */
export interface DiffRepository {
  git: GitContextLike
  from: string
  fromCommit: string
  to: string
  /** The resolved commit, or null when `to` is the working tree. */
  toCommit: string | null
  /** True when `to` is `WORKTREE`. */
  worktree: boolean
}

/** Normalize one revision argument; an empty string means "use the default". */
function revisionArgument(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) return fallback
  return trimmed.toUpperCase() === WORKTREE ? WORKTREE : trimmed
}

/** Resolve one revision to a commit hash, refusing a revision that does not exist. */
async function resolveCommit(git: GitContextLike, revision: string, role: 'from' | 'to'): Promise<string> {
  const result = await git.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
  const commit = result.stdout.trim()
  if (result.code !== 0 || commit.length === 0) {
    throw new EngineeringContextError(
      'invalid_argument',
      `The ${role} revision "${revision}" does not exist in this repository. Pass a commit, tag or branch that is present ` +
        `(the defaults are ${DIFF_DEFAULT_FROM} and ${DIFF_DEFAULT_TO}), or pass from/to explicitly.`,
      { revision, role, stderr: result.stderr.trim() },
    )
  }
  return commit
}

/**
 * Bind the workspace repository through the host's `gitContext` service.
 *
 * The service is looked up by name (never imported), exactly like the sync path.
 * A composition without the git plugin gets a coded refusal instead of a shell
 * fallback: this plugin has no generic git runner for arbitrary revisions.
 *
 * @param ctx - the plugin context.
 * @param root - the canonical workspace root.
 * @returns the bound repository context.
 */
export async function openDiffRepository(ctx: Context, root: string): Promise<GitContextLike> {
  const service = gitContextService(ctx)
  if (service === undefined) {
    throw new EngineeringContextError(
      'git_access_unavailable',
      'This composition has no gitContext service, so revisions cannot be read. Enable the git tool plugin ' +
        '(dsh-tool-git) — project_diff only reads history through that service and never runs git itself.',
      { service: 'gitContext' },
    )
  }
  let repository = false
  try {
    repository = await service.isRepository(root)
  } catch {
    repository = false
  }
  if (!repository) {
    throw new EngineeringContextError(
      'repository_not_found',
      `${root} is not inside a git repository. project_diff compares committed revisions (or the working tree against one) ` +
        'and never creates a repository: initialize and commit the workspace first.',
      { workspace: root },
    )
  }
  try {
    return await service.create(root)
  } catch (error) {
    throw new EngineeringContextError(
      'git_failed',
      `The gitContext service could not bind the repository containing ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { workspace: root },
    )
  }
}

/** Resolve both revisions; `to === WORKTREE` leaves `toCommit` null. */
export async function resolveDiffRevisions(
  git: GitContextLike,
  fromArgument?: string,
  toArgument?: string,
): Promise<Omit<DiffRepository, 'git'>> {
  const from = revisionArgument(fromArgument, DIFF_DEFAULT_FROM)
  const to = revisionArgument(toArgument, DIFF_DEFAULT_TO)
  if (from.toUpperCase() === WORKTREE) {
    throw new EngineeringContextError(
      'invalid_argument',
      `\`from\` must be a committed revision; only \`to\` may be ${WORKTREE} (the working tree).`,
      { from, to },
    )
  }
  const fromCommit = await resolveCommit(git, from, 'from')
  if (to.toUpperCase() === WORKTREE) return { from, fromCommit, to: WORKTREE, toCommit: null, worktree: true }
  const toCommit = await resolveCommit(git, to, 'to')
  return { from, fromCommit, to, toCommit, worktree: false }
}

/** One path relative to the repository root, spelled with forward slashes. */
function repoRelative(repoDir: string, absolute: string): string {
  const rel = relative(repoDir, absolute)
  if (rel.length === 0 || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new EngineeringContextError(
      'invalid_argument',
      `The device directory ${absolute} is outside the repository ${repoDir}, so git cannot address its files. ` +
        'Move the workspace inside the repository (or run from the repository root).',
      { repository: repoDir, directory: absolute },
    )
  }
  return rel.split(sep).join('/')
}

/** Read one file at a revision (`WORKTREE`/null reads the working file). */
async function textAt(git: GitContextLike, commit: string | null, gitPath: string): Promise<string | null> {
  if (commit === null) {
    try {
      return await readFile(join(git.repoDir, gitPath), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new EngineeringContextError('git_failed', `The working file ${gitPath} could not be read.`, {
        path: gitPath,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const result = await git.run(['show', `${commit}:${gitPath}`])
  // A missing path in a revision is data for an added/removed file; a revision
  // that does not exist was already refused by resolveCommit.
  return result.code === 0 ? result.stdout : null
}

interface EvidenceAtRevision {
  document: EvidenceDocument | null
  warning: string | null
}

/** Read one ledger at a revision; a corrupt ledger is a warning, not a failure. */
async function evidenceAt(
  git: GitContextLike,
  commit: string | null,
  gitPath: string,
  label: string,
): Promise<EvidenceAtRevision> {
  const raw = await textAt(git, commit, gitPath)
  if (raw === null) return { document: null, warning: null }
  try {
    return { document: parseEvidenceDocument(raw, label), warning: null }
  } catch (error) {
    return {
      document: null,
      warning: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Find one evidence object by name, preferring an object that still has a path. */
function evidenceObject(document: EvidenceDocument | null, name: string): EvidenceObject | null {
  if (document === null) return null
  const values = [...document.objects.values()]
  const exact = values.find((entry) => entry.name === name && entry.path !== null)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  return values.find((entry) => entry.name.toLowerCase() === lower && entry.path !== null) ?? null
}

/** Find one evidence object by its device-relative path. */
function evidenceObjectAtPath(document: EvidenceDocument | null, devicePath: string): EvidenceObject | null {
  if (document === null) return null
  const wanted = devicePath.replace(/\\/gu, '/').toLowerCase()
  return (
    [...document.objects.values()].find(
      (entry) => entry.path !== null && entry.path.replace(/\\/gu, '/').toLowerCase() === wanted,
    ) ?? null
  )
}

// ---------------------------------------------------------------------------
// Changed-file discovery
// ---------------------------------------------------------------------------

/** How one XML file changed between the two revisions. */
export type FileChange = 'added' | 'removed' | 'modified' | 'unchanged'

/** One XML file the diff has to explain. */
export interface DiffFile {
  /** Path relative to the repository root (what `git show` takes). */
  gitPath: string
  /** Path relative to the device directory (what the ledger records). */
  devicePath: string
  /** Workspace-relative portable spelling, for the model. */
  displayPath: string
  change: FileChange
}

interface DiscoveredFile {
  path: string
  status: 'added' | 'removed' | 'modified'
}

/** Parse `git diff --name-status -z` output (renames become a removal plus an addition). */
function parseNameStatus(output: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = []
  const tokens = output.split('\u0000').filter((token) => token.length > 0)
  let index = 0
  while (index < tokens.length) {
    const status = tokens[index]
    index += 1
    if (status === undefined) break
    const code = status.charAt(0).toUpperCase()
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[index]
      const newPath = tokens[index + 1]
      index += 2
      if (oldPath !== undefined && oldPath.length > 0) files.push({ path: oldPath, status: 'removed' })
      if (newPath !== undefined && newPath.length > 0) files.push({ path: newPath, status: 'added' })
      continue
    }
    const path = tokens[index]
    index += 1
    if (path === undefined || path.length === 0) continue
    files.push({
      path,
      status: code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified',
    })
  }
  return files
}

/**
 * The XML files that changed under the given pathspecs.
 *
 * For `WORKTREE`, untracked files are added to git's own `diff` output: a newly
 * exported block has never been committed, and `git diff <commit>` cannot see it.
 */
async function changedFiles(
  git: GitContextLike,
  fromCommit: string,
  toCommit: string | null,
  prefixes: readonly string[],
): Promise<DiscoveredFile[]> {
  const args =
    toCommit === null
      ? ['diff', '--name-status', '-z', '-M', fromCommit, '--', ...prefixes]
      : ['diff', '--name-status', '-z', '-M', fromCommit, toCommit, '--', ...prefixes]
  const result = await git.run(args)
  if (result.code !== 0) {
    throw new EngineeringContextError('git_failed', 'git diff failed while listing changed block XML.', {
      from: fromCommit,
      to: toCommit,
      stderr: result.stderr.trim(),
    })
  }
  const discovered = parseNameStatus(result.stdout)

  if (toCommit === null) {
    // `-z` keeps non-ASCII block paths (common in Chinese projects) unquoted.
    const untracked = await git.run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...prefixes])
    if (untracked.code === 0) {
      for (const path of untracked.stdout.split('\u0000')) {
        const trimmed = path.trim()
        if (trimmed.length > 0) discovered.push({ path: trimmed, status: 'added' })
      }
    }
  }

  const seen = new Map<string, DiscoveredFile>()
  for (const file of discovered) {
    if (!/\.xml$/iu.test(file.path)) continue
    if (!seen.has(file.path)) seen.set(file.path, file)
  }
  return [...seen.values()].sort((left, right) => left.path.localeCompare(right.path))
}

/** Derive the real change from whether the content exists on each side. */
function changeOf(oldXml: string | null, newXml: string | null): FileChange {
  if (oldXml === null && newXml === null) return 'unchanged'
  if (oldXml === null) return 'added'
  if (newXml === null) return 'removed'
  return oldXml === newXml ? 'unchanged' : 'modified'
}

// ---------------------------------------------------------------------------
// Simatic ML parsing (preserve-order)
// ---------------------------------------------------------------------------

/** One element of `fast-xml-parser`'s preserve-order output. */
type OrderedNode = Record<string, unknown>

/** The attribute member of one preserve-order node. */
const ATTRS = ':@'

function isOrderedNode(value: unknown): value is OrderedNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The element name of one node (`null` for a text node). */
function elementName(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ATTRS || key === '#text' || key === '#cdata') continue
    return key
  }
  return null
}

/** The child nodes of one element. */
function elementChildren(node: OrderedNode): OrderedNode[] {
  const name = elementName(node)
  if (name === null) return []
  const value = node[name]
  return Array.isArray(value) ? value.filter(isOrderedNode) : []
}

/** Children of one element carrying exactly this name. */
function childrenNamed(node: OrderedNode, name: string): OrderedNode[] {
  return elementChildren(node).filter((child) => elementName(child) === name)
}

/** The first child of this name, or null. */
function childNamed(node: OrderedNode, name: string): OrderedNode | null {
  return childrenNamed(node, name)[0] ?? null
}

/** One attribute value, or null. */
function attribute(node: OrderedNode, name: string): string | null {
  const attrs = node[ATTRS]
  if (!isOrderedNode(attrs)) return null
  const value = attrs[`@_${name}`]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The direct text content of one element. */
function directText(node: OrderedNode): string {
  const name = elementName(node)
  if (name === null) return ''
  const value = node[name]
  if (!Array.isArray(value)) return ''
  for (const child of value) {
    if (!isOrderedNode(child)) continue
    const text = child['#text']
    if (typeof text === 'string') return text
    if (typeof text === 'number') return String(text)
  }
  return ''
}

/** The direct text of a named child (empty string when absent). */
function childText(node: OrderedNode, name: string): string {
  const child = childNamed(node, name)
  return child === null ? '' : directText(child)
}

/** The last dotted segment of an element name (`SW.Blocks.Part` → `Part`). */
function lastSegment(name: string): string {
  const parts = name.split('.')
  return parts[parts.length - 1] ?? name
}

/** One compile unit / network, reduced to what a bounded diff reports. */
export interface ParsedUnit {
  key: string
  id: string | null
  label: string | null
  parts: number
  wires: number
  accesses: number
  signature: string
}

/** One interface member, keyed by its path inside the interface. */
export interface ParsedMember {
  section: string
  name: string
  path: string
  datatype: string
  comment: string
}

/** One multilingual text item (owner, culture, text). */
export interface ParsedText {
  owner: string
  culture: string
  text: string
}

/** Everything this tool extracts from one block XML. */
export interface ParsedBlock {
  kind: string | null
  category: 'block' | 'type'
  name: string | null
  number: string | null
  language: string | null
  units: ParsedUnit[]
  members: ParsedMember[]
  texts: ParsedText[]
}

/** A parse outcome: either the extracted summary or the reason there is none. */
export type ParseOutcome =
  | { state: 'ok'; block: ParsedBlock }
  | { state: 'failed' | 'skipped'; message: string }

/**
 * One parser instance is enough: parsing is synchronous and the options are
 * fixed. `parseTagValue: false` keeps TIA's IDs and numbers as the exact strings
 * git stored, which is what makes a cross-revision comparison meaningful.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  allowBooleanAttributes: true,
})

/** Count Part / Wire / Access elements anywhere below one unit. */
function countObjects(node: OrderedNode): { parts: number; wires: number; accesses: number } {
  let parts = 0
  let wires = 0
  let accesses = 0
  const walk = (current: OrderedNode): void => {
    for (const child of elementChildren(current)) {
      const name = elementName(child)
      if (name !== null) {
        const last = lastSegment(name)
        if (last === 'Part') parts += 1
        else if (last === 'Wire') wires += 1
        else if (last === 'Access') accesses += 1
      }
      walk(child)
    }
  }
  walk(node)
  return { parts, wires, accesses }
}

/** A stable structural fingerprint of one element (order-sensitive by design). */
function signatureOf(node: OrderedNode): string {
  return createHash('sha1').update(JSON.stringify(node)).digest('hex').slice(0, 16)
}

/** Whether an element name is a compile unit (a TIA network or an SCL unit). */
function isUnitName(name: string | null): boolean {
  if (name === null) return false
  const last = lastSegment(name)
  return last === 'CompileUnit' || last === 'Network'
}

/** Collect every multilingual text item under one node, tagging units as owners. */
function collectTexts(block: OrderedNode): ParsedText[] {
  const texts: ParsedText[] = []
  const seen = new Set<string>()
  const walk = (node: OrderedNode, owner: string): void => {
    const name = elementName(node)
    if (name === 'MultilingualTextItem') {
      const attrs = childNamed(node, 'AttributeList')
      if (attrs !== null) {
        const culture = childText(attrs, 'Culture').trim()
        const text = childText(attrs, 'Text')
        if (text.trim().length > 0) {
          const item: ParsedText = { owner, culture: culture.length > 0 ? culture : 'unknown', text }
          const key = `${item.owner}\u0000${item.culture}\u0000${item.text}`
          if (!seen.has(key)) {
            seen.add(key)
            texts.push(item)
          }
        }
      }
      return
    }
    let nextOwner = owner
    if (isUnitName(name)) {
      const id = attribute(node, 'ID')
      nextOwner = id === null ? 'unit' : `unit ${id}`
    }
    for (const child of elementChildren(node)) walk(child, nextOwner)
  }
  walk(block, 'block')
  return texts
}

/** First text item under a node, optionally not descending into nested members. */
function firstOwnText(node: OrderedNode, skipMembers: boolean): string {
  for (const child of elementChildren(node)) {
    const name = elementName(child)
    if (name === 'MultilingualTextItem') {
      const attrs = childNamed(child, 'AttributeList')
      return attrs === null ? '' : childText(attrs, 'Text')
    }
    if (skipMembers && name === 'Member') continue
    const found = firstOwnText(child, skipMembers)
    if (found.length > 0) return found
  }
  return ''
}

/** Parse a block's interface members, nested Structs included. */
function parseMembers(block: OrderedNode): ParsedMember[] {
  const attributes = childNamed(block, 'AttributeList')
  const iface = attributes === null ? null : childNamed(attributes, 'Interface')
  if (iface === null) return []
  const members: ParsedMember[] = []

  // A nested Struct's own <Section Name="None"> is an implementation detail:
  // its members keep the outer section (Input / Output / InOut / …) so the
  // result names the section a programmer sees.
  const walkMembers = (parent: OrderedNode, section: string, prefix: string): void => {
    for (const member of childrenNamed(parent, 'Member')) {
      const name = attribute(member, 'Name') ?? '(unnamed)'
      const path = prefix.length === 0 ? name : `${prefix}.${name}`
      const nested = childNamed(member, 'Sections')
      const datatype = attribute(member, 'Datatype') ?? (nested !== null ? 'Struct' : 'Unknown')
      members.push({
        section,
        name,
        path,
        datatype,
        comment: firstOwnText(member, true).trim(),
      })
      if (nested !== null) {
        for (const inner of childrenNamed(nested, 'Section')) walkMembers(inner, section, path)
      }
    }
  }

  const walkSections = (sections: OrderedNode, prefix: string): void => {
    for (const section of childrenNamed(sections, 'Section')) {
      walkMembers(section, attribute(section, 'Name') ?? 'Unknown', prefix)
    }
  }

  const sections = childNamed(iface, 'Sections')
  if (sections !== null) walkSections(sections, '')
  return members
}

/** Parse the compile units (networks) of one block, in element order. */
function parseUnits(block: OrderedNode): ParsedUnit[] {
  const list = childNamed(block, 'ObjectList')
  if (list === null) return []
  const units: ParsedUnit[] = []
  const used = new Set<string>()

  for (const [index, unit] of elementChildren(list).entries()) {
    const name = elementName(unit)
    if (!isUnitName(name)) continue
    const id = attribute(unit, 'ID') ?? attribute(unit, 'CompositionName')
    let key = id === null ? `#${index}` : id
    if (used.has(key)) key = `${key}#${index}`
    used.add(key)
    const counts = countObjects(unit)
    const texts = collectTexts(unit)
    units.push({
      key,
      id,
      label: texts[0]?.text ?? null,
      parts: counts.parts,
      wires: counts.wires,
      accesses: counts.accesses,
      signature: signatureOf(unit),
    })
  }
  return units
}

/** Extract one block from the XML document's root object. */
function parsedBlock(xml: string): ParsedBlock | { error: string } {
  let document: unknown
  try {
    document = xmlParser.parse(xml)
  } catch (error) {
    return { error: `the XML could not be parsed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const roots = Array.isArray(document) ? document.filter(isOrderedNode) : []
  const documentNode = roots.find((node) => elementName(node) === 'Document') ?? null
  const searchRoot =
    documentNode ??
    roots.find((node) => {
      const name = elementName(node)
      return name !== null && name.startsWith('SW.')
    }) ??
    null
  if (searchRoot === null) return { error: 'no <Document> element was found; this does not look like Simatic ML' }

  let block: OrderedNode | null = null
  const queue: OrderedNode[] = [searchRoot]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) break
    const name = elementName(node)
    if (name !== null && (name.startsWith('SW.Blocks.') || name.startsWith('SW.Types.'))) {
      block = node
      break
    }
    queue.push(...elementChildren(node))
  }
  if (block === null) return { error: 'no <SW.Blocks.*> or <SW.Types.*> object was found in the document' }

  const kind = elementName(block)?.replace(/^SW\.(Blocks|Types)\./u, '') ?? null
  const category: ParsedBlock['category'] = elementName(block)?.startsWith('SW.Types.') === true ? 'type' : 'block'
  const attributes = childNamed(block, 'AttributeList')
  return {
    kind,
    category,
    name: attributes === null ? null : childText(attributes, 'Name').trim() || null,
    number: attributes === null ? null : childText(attributes, 'Number').trim() || null,
    language: attributes === null ? null : childText(attributes, 'ProgrammingLanguage').trim() || null,
    units: parseUnits(block),
    members: parseMembers(block),
    texts: collectTexts(block),
  }
}

/** Apply the size bound before parsing; a huge file is skipped, never dumped. */
function parseSafely(xml: string | null): ParseOutcome | null {
  if (xml === null) return null
  if (xml.length > DIFF_MAX_XML_CHARS) {
    return {
      state: 'skipped',
      message: `the XML is ${xml.length} characters, above the ${DIFF_MAX_XML_CHARS}-character parse limit`,
    }
  }
  const result = parsedBlock(xml)
  if ('error' in result) return { state: 'failed', message: result.error }
  return { state: 'ok', block: result }
}

// ---------------------------------------------------------------------------
// Bounded comparison helpers
// ---------------------------------------------------------------------------

/** A list reported as exact count plus the first N entries. */
export interface Bounded<T> {
  count: number
  returned: number
  truncated: boolean
  items: T[]
}

/** Keep the first `max` entries and the exact count. */
export function bounded<T>(items: readonly T[], max: number): Bounded<T> {
  const returned = Math.min(items.length, max)
  return { count: items.length, returned, truncated: items.length > returned, items: items.slice(0, returned) }
}

/** One unit's Part/Wire/Access delta. */
export interface UnitChange {
  id: string | null
  label: string | null
  parts: { from: number; to: number; delta: number }
  wires: { from: number; to: number; delta: number }
  accesses: { from: number; to: number; delta: number }
}

/** The unit-level comparison of one block. */
export interface UnitComparison {
  from: number
  to: number
  added: Bounded<{ id: string | null; label: string | null }>
  removed: Bounded<{ id: string | null; label: string | null }>
  changed: Bounded<UnitChange>
}

/** The interface-level comparison of one block. */
export interface MemberComparison {
  from: number
  to: number
  added: Bounded<{ section: string; name: string; datatype: string }>
  removed: Bounded<{ section: string; name: string; datatype: string }>
  changed: Bounded<{ section: string; name: string; datatype: { from: string; to: string }; commentChanged: boolean }>
}

/** The multilingual-text comparison of one block. */
export interface TextComparison {
  added: Bounded<ParsedText>
  removed: Bounded<ParsedText>
}

/** Compare the units of two parses, keyed by TIA's own ID. */
export function compareUnits(oldUnits: readonly ParsedUnit[], newUnits: readonly ParsedUnit[], max: number): UnitComparison {
  const oldMap = new Map(oldUnits.map((unit) => [unit.key, unit] as const))
  const newMap = new Map(newUnits.map((unit) => [unit.key, unit] as const))

  const added: { id: string | null; label: string | null }[] = []
  const removed: { id: string | null; label: string | null }[] = []
  const changed: UnitChange[] = []

  for (const [key, unit] of newMap) {
    const previous = oldMap.get(key)
    if (previous === undefined) {
      added.push({ id: unit.id, label: unit.label })
      continue
    }
    if (previous.signature === unit.signature) continue
    changed.push({
      id: unit.id,
      label: unit.label ?? previous.label,
      parts: { from: previous.parts, to: unit.parts, delta: unit.parts - previous.parts },
      wires: { from: previous.wires, to: unit.wires, delta: unit.wires - previous.wires },
      accesses: { from: previous.accesses, to: unit.accesses, delta: unit.accesses - previous.accesses },
    })
  }
  for (const [key, unit] of oldMap) {
    if (!newMap.has(key)) removed.push({ id: unit.id, label: unit.label })
  }

  return {
    from: oldUnits.length,
    to: newUnits.length,
    added: bounded(added, max),
    removed: bounded(removed, max),
    changed: bounded(changed, max),
  }
}

/** Compare interface members by path (nested Structs included). */
export function compareMembers(
  oldMembers: readonly ParsedMember[],
  newMembers: readonly ParsedMember[],
  max: number,
): MemberComparison {
  // The section is part of the identity: a member moved from Input to Output is
  // a removal plus an addition, not a silent non-change.
  const keyOf = (member: ParsedMember): string => `${member.section}\u0000${member.path}`
  const oldMap = new Map(oldMembers.map((member) => [keyOf(member), member] as const))
  const newMap = new Map(newMembers.map((member) => [keyOf(member), member] as const))

  const added: { section: string; name: string; datatype: string }[] = []
  const removed: { section: string; name: string; datatype: string }[] = []
  const changed: { section: string; name: string; datatype: { from: string; to: string }; commentChanged: boolean }[] = []

  for (const [key, member] of newMap) {
    const previous = oldMap.get(key)
    if (previous === undefined) {
      added.push({ section: member.section, name: member.name, datatype: member.datatype })
      continue
    }
    if (previous.datatype === member.datatype && previous.comment === member.comment) continue
    changed.push({
      section: member.section,
      name: member.name,
      datatype: { from: previous.datatype, to: member.datatype },
      commentChanged: previous.comment !== member.comment,
    })
  }
  for (const [key, member] of oldMap) {
    if (!newMap.has(key)) removed.push({ section: member.section, name: member.name, datatype: member.datatype })
  }

  return {
    from: oldMembers.length,
    to: newMembers.length,
    added: bounded(added, max),
    removed: bounded(removed, max),
    changed: bounded(changed, max),
  }
}

/** Compare multilingual text items as a set (a retitled item is one removal plus one addition). */
export function compareTexts(oldTexts: readonly ParsedText[], newTexts: readonly ParsedText[], max: number): TextComparison {
  const keyOf = (item: ParsedText): string => `${item.owner}\u0000${item.culture}\u0000${item.text}`
  const oldKeys = new Set(oldTexts.map(keyOf))
  const newKeys = new Set(newTexts.map(keyOf))
  return {
    added: bounded(newTexts.filter((item) => !oldKeys.has(keyOf(item))), max),
    removed: bounded(oldTexts.filter((item) => !newKeys.has(keyOf(item))), max),
  }
}

/** Which faces the evidence ledgers say changed, or an honest `unknown`. */
export function compareFaces(
  previous: EvidenceObject | null,
  current: EvidenceObject | null,
): { state: 'known' | 'unknown'; changed: string[] } {
  const before = previous?.fingerprint ?? null
  const after = current?.fingerprint ?? null
  if (before === null && after === null) return { state: 'unknown', changed: [] }

  const changed: string[] = []
  if (before === null || after === null) {
    // One side has no object at all (block added or removed): every face its
    // ledger recorded is part of the change.
    changed.push(...Object.keys(after ?? before ?? {}))
  } else {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) if (before[key] !== after[key]) changed.push(key)
  }
  changed.sort()
  return { state: 'known', changed }
}

// ---------------------------------------------------------------------------
// The result shape
// ---------------------------------------------------------------------------

/** Identity of one block, as the result reports it. */
export interface BlockIdentity {
  device: string
  name: string | null
  group: string | null
  category: string
  path: string
  language: string | null
  kind: string | null
  number: string | null
}

/** One block's bounded, structural explanation. */
export interface BlockDiff {
  identity: BlockIdentity
  change: FileChange
  faces: { state: 'known' | 'unknown'; changed: string[] }
  parse: { state: 'ok' | 'failed' | 'skipped'; message: string | null }
  units: UnitComparison | null
  interface: MemberComparison | null
  text: TextComparison | null
}

/** The payload of one `project_diff` call. */
export interface ProjectDiffPayload {
  revisions: {
    from: string
    to: string
    fromCommit: string
    toCommit: string | null
    worktree: boolean
  }
  device: {
    device: string
    software: string | null
    directory: string
    resolvedFrom: 'index' | 'evidence'
  }
  filter: { block: string | null; maxItems: number }
  files: {
    discovered: number
    considered: number
    omitted: number
    added: number
    removed: number
    modified: number
    items: { path: string; change: FileChange }[]
  }
  blocks: BlockDiff[]
  limits: { maxItems: number; maxXmlChars: number }
}

/** One tool-ready diff result: payload plus the model-facing prose. */
export interface ProjectDiffResult {
  summary: string
  details: string[]
  warnings: string[]
  data: ProjectDiffPayload
}

/** The input to one diff run. */
export interface ProjectDiffOptions {
  /** The plugin context (for `ctx.get('gitContext')`). */
  ctx: Context
  /** The resolved configuration. */
  config: PluginConfig
  /** The canonical workspace root. */
  root: string
  block?: string
  device?: string
  from?: string
  to?: string
  maxItems?: number
}

/** Clamp `max_items` into the supported range. */
export function clampMaxItems(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DIFF_DEFAULT_MAX_ITEMS
  const integer = Math.floor(value)
  if (integer < 1) return 1
  return Math.min(integer, DIFF_MAX_ITEMS)
}

/** The group segment of a device-relative block path (`blocks/010_Cell/FC1.xml` → `010_Cell`). */
function groupOf(devicePath: string): string | null {
  const segments = devicePath.replace(/\\/gu, '/').split('/')
  if (segments.length >= 3) return segments[segments.length - 2] ?? null
  return null
}

/** Look up an evidence object for one path, falling back to the parsed name. */
function evidenceFor(
  document: EvidenceDocument | null,
  devicePath: string,
  name: string | null,
): EvidenceObject | null {
  return evidenceObjectAtPath(document, devicePath) ?? (name === null ? null : evidenceObject(document, name))
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run one structural diff.
 *
 * @param options - the workspace, revisions, optional block filter and bounds.
 * @returns the bounded payload and the lines the model reads.
 * @throws {EngineeringContextError} for a missing service, repository, device,
 *   revision or path — always with a stable code.
 */
export async function projectDiff(options: ProjectDiffOptions): Promise<ProjectDiffResult> {
  const maxItems = clampMaxItems(options.maxItems)
  const device = await resolveDiffDevice(options.config, options.root, options.device)
  const git = await openDiffRepository(options.ctx, options.root)
  const revisions = await resolveDiffRevisions(git, options.from, options.to)
  const deviceGitDir = repoRelative(git.repoDir, device.directory)

  const warnings: string[] = []
  const fromLabel = `${revisions.from}`
  const toLabel = revisions.to

  const previousEvidence = await evidenceAt(
    git,
    revisions.fromCommit,
    `${deviceGitDir}/${EVIDENCE_FILE}`,
    `${fromLabel}:${deviceGitDir}/${EVIDENCE_FILE}`,
  )
  const currentEvidence = await evidenceAt(
    git,
    revisions.toCommit,
    `${deviceGitDir}/${EVIDENCE_FILE}`,
    `${revisions.worktree ? 'WORKTREE' : toLabel}:${deviceGitDir}/${EVIDENCE_FILE}`,
  )
  if (previousEvidence.warning !== null) warnings.push(previousEvidence.warning)
  if (currentEvidence.warning !== null) warnings.push(currentEvidence.warning)

  const blockName = typeof options.block === 'string' ? options.block.trim() : ''

  /** The files to explain, before the bound is applied. */
  let files: DiffFile[]
  const preloaded = new Map<string, { oldXml: string | null; newXml: string | null }>()
  if (blockName.length > 0) {
    const object =
      evidenceObject(currentEvidence.document, blockName) ?? evidenceObject(previousEvidence.document, blockName)
    if (object === null || object.path === null) {
      throw new EngineeringContextError(
        'invalid_argument',
        `The block ${blockName} is not recorded with a file path in the evidence ledger of ${device.device}. ` +
          'Pass a block name as project_status/sync report it, or omit block to diff every changed XML file.',
        { device: device.device, block: blockName },
      )
    }
    const devicePath = object.path.replace(/\\/gu, '/')
    const gitPath = `${deviceGitDir}/${devicePath}`
    const oldXml = await textAt(git, revisions.fromCommit, gitPath)
    const newXml = await textAt(git, revisions.toCommit, gitPath)
    if (oldXml === null && newXml === null) {
      throw new EngineeringContextError(
        'invalid_argument',
        `The block ${blockName} is recorded at ${devicePath}, but that path exists in neither ${fromLabel} nor ${toLabel}. ` +
          'The ledger and the commits disagree; run project_status and sync before diffing.',
        { device: device.device, block: blockName, path: devicePath, from: fromLabel, to: toLabel },
      )
    }
    preloaded.set(gitPath, { oldXml, newXml })
    files = [
      {
        gitPath,
        devicePath,
        displayPath: `${toPortable(options.root, device.directory)}/${devicePath}`,
        change: changeOf(oldXml, newXml),
      },
    ]
  } else {
    const discovered = await changedFiles(git, revisions.fromCommit, revisions.toCommit, [
      `${deviceGitDir}/blocks`,
      `${deviceGitDir}/types`,
    ])
    const directoryDisplay = toPortable(options.root, device.directory)
    files = discovered.map((file) => {
      const devicePath = file.path.slice(deviceGitDir.length + 1)
      return {
        gitPath: file.path,
        devicePath,
        displayPath: `${directoryDisplay}/${devicePath}`,
        change: 'unchanged' as FileChange,
      }
    })
  }

  // Read and classify up to the bound: counts outside it are reported as omitted
  // rather than silently dropped.
  const considered = files.slice(0, maxItems)
  const blocks: BlockDiff[] = []
  const finalFiles: { path: string; change: FileChange }[] = []

  for (const file of considered) {
    const cached = preloaded.get(file.gitPath)
    const oldXml = cached === undefined ? await textAt(git, revisions.fromCommit, file.gitPath) : cached.oldXml
    const newXml = cached === undefined ? await textAt(git, revisions.toCommit, file.gitPath) : cached.newXml
    const change = changeOf(oldXml, newXml)
    file.change = change
    if (change === 'unchanged') continue
    finalFiles.push({ path: file.displayPath, change })

    blocks.push(
      summarizeBlock({
        device,
        root: options.root,
        file,
        oldXml,
        newXml,
        change,
        oldEvidence: previousEvidence.document,
        newEvidence: currentEvidence.document,
        maxItems,
      }),
    )
  }

  const counted = { added: 0, removed: 0, modified: 0 } as Record<Exclude<FileChange, 'unchanged'>, number>
  for (const block of blocks) {
    if (block.change === 'added') counted.added += 1
    else if (block.change === 'removed') counted.removed += 1
    else if (block.change === 'modified') counted.modified += 1
  }

  const data: ProjectDiffPayload = {
    revisions: {
      from: revisions.from,
      to: revisions.to,
      fromCommit: revisions.fromCommit,
      toCommit: revisions.toCommit,
      worktree: revisions.worktree,
    },
    device: {
      device: device.device,
      software: device.software,
      directory: toPortable(options.root, device.directory),
      resolvedFrom: device.resolvedFrom,
    },
    filter: { block: blockName.length > 0 ? blockName : null, maxItems },
    files: {
      discovered: files.length,
      considered: considered.length,
      omitted: Math.max(0, files.length - considered.length),
      added: counted.added,
      removed: counted.removed,
      modified: counted.modified,
      items: finalFiles.slice(0, maxItems),
    },
    blocks,
    limits: { maxItems, maxXmlChars: DIFF_MAX_XML_CHARS },
  }

  const details: string[] = []
  details.push(
    `Revisions: ${revisions.from} (${revisions.fromCommit.slice(0, 8)}) → ${
      revisions.worktree ? 'WORKTREE' : `${revisions.to} (${(revisions.toCommit ?? '').slice(0, 8)})`
    }.`,
  )
  details.push(
    `Device: ${device.device}${device.software === null ? '' : ` / ${device.software}`} — ${toPortable(options.root, device.directory)}/ ` +
      `(${device.resolvedFrom === 'index' ? 'from the source index' : 'from the evidence ledger scan'}).`,
  )
  if (blocks.length === 0) {
    details.push('No changed block XML was found for this device between those revisions.')
  }
  for (const block of blocks.slice(0, DIFF_DEFAULT_MAX_ITEMS)) details.push(...blockDetailLines(block))
  if (blocks.length > DIFF_DEFAULT_MAX_ITEMS) {
    details.push(`… ${blocks.length - DIFF_DEFAULT_MAX_ITEMS} more block(s) omitted from the text summary (the payload carries ${blocks.length}).`)
  }
  if (data.files.omitted > 0) {
    details.push(
      `… ${data.files.omitted} more changed XML file(s) not summarised (max_items=${maxItems}); the added/removed/modified ` +
        'counts cover only the files that were considered. Raise max_items or pass block to narrow the diff.',
    )
  }

  const changedTotal = counted.added + counted.removed + counted.modified
  const range = `${revisions.from} and ${revisions.worktree ? 'WORKTREE' : revisions.to}`
  const summary =
    changedTotal === 0
      ? `No block XML changed for ${device.device} between ${range}.`
      : `${data.files.discovered} XML file(s) changed for ${device.device} between ${range} ` +
        `(${counted.added} added, ${counted.removed} removed, ${counted.modified} modified); ${blocks.length} block(s) summarised` +
        (data.files.omitted > 0 ? `, ${data.files.omitted} file(s) omitted.` : '.')

  return { summary, details, warnings, data }
}

/** Build one bounded block summary from the raw XML of both revisions. */
function summarizeBlock(input: {
  device: DiffDevice
  root: string
  file: DiffFile
  oldXml: string | null
  newXml: string | null
  change: FileChange
  oldEvidence: EvidenceDocument | null
  newEvidence: EvidenceDocument | null
  maxItems: number
}): BlockDiff {
  const oldOutcome = parseSafely(input.oldXml)
  const newOutcome = parseSafely(input.newXml)
  // A file that does not exist in a revision is an empty block, not a failure:
  // that is exactly how an added or removed block is compared.
  const empty: ParsedBlock = {
    kind: null,
    category: 'block',
    name: null,
    number: null,
    language: null,
    units: [],
    members: [],
    texts: [],
  }
  const oldBlock =
    oldOutcome?.state === 'ok' ? oldOutcome.block : input.oldXml === null ? empty : null
  const newBlock =
    newOutcome?.state === 'ok' ? newOutcome.block : input.newXml === null ? empty : null

  let parseState: 'ok' | 'failed' | 'skipped' = 'ok'
  let parseMessage: string | null = null
  for (const outcome of [oldOutcome, newOutcome]) {
    if (outcome !== null && outcome.state !== 'ok') {
      parseState = outcome.state
      parseMessage = outcome.message
      break
    }
  }

  const name = newBlock?.name ?? oldBlock?.name ?? null
  const previousObject = evidenceFor(input.oldEvidence, input.file.devicePath, oldBlock?.name ?? name)
  const currentObject = evidenceFor(input.newEvidence, input.file.devicePath, newBlock?.name ?? name)

  const identity: BlockIdentity = {
    device: input.device.device,
    name: name ?? previousObject?.name ?? currentObject?.name ?? basename(input.file.devicePath, '.xml'),
    group: currentObject?.group ?? previousObject?.group ?? groupOf(input.file.devicePath),
    category:
      currentObject?.category ??
      (newBlock?.name === null ? undefined : newBlock?.category) ??
      oldBlock?.category ??
      newBlock?.category ??
      'block',
    path: `${toPortable(input.root, input.device.directory)}/${input.file.devicePath}`,
    language: newBlock?.language ?? oldBlock?.language ?? null,
    kind: newBlock?.kind ?? oldBlock?.kind ?? null,
    number: newBlock?.number ?? oldBlock?.number ?? null,
  }

  return {
    identity,
    change: input.change,
    faces: compareFaces(previousObject, currentObject),
    parse: { state: parseState, message: parseMessage },
    units:
      oldBlock === null || newBlock === null
        ? null
        : compareUnits(oldBlock.units, newBlock.units, input.maxItems),
    interface:
      oldBlock === null || newBlock === null
        ? null
        : compareMembers(oldBlock.members, newBlock.members, input.maxItems),
    text:
      oldBlock === null || newBlock === null
        ? null
        : compareTexts(oldBlock.texts, newBlock.texts, input.maxItems),
  }
}

/** One block's model-facing detail line. */
function blockDetailLines(block: BlockDiff): string[] {
  const lines: string[] = []
  const units = block.units
  const members = block.interface
  const text = block.text
  const parts: string[] = [`${block.identity.name ?? '(unnamed)'} (${block.identity.category}, ${block.change})`]
  if (block.parse.state !== 'ok') parts.push(`parse ${block.parse.state}: ${block.parse.message ?? 'unknown reason'}`)
  if (units !== null) {
    parts.push(`units ${units.from}→${units.to}`)
    if (units.added.count > 0 || units.removed.count > 0 || units.changed.count > 0) {
      parts.push(`+${units.added.count}/-${units.removed.count}/~${units.changed.count}`)
      const first = units.changed.items[0]
      if (first !== undefined) {
        parts.push(
          `changed unit ${first.id ?? '?'}: parts ${first.parts.from}→${first.parts.to}, wires ${first.wires.from}→${first.wires.to}, accesses ${first.accesses.from}→${first.accesses.to}`,
        )
      }
    }
  }
  if (members !== null && (members.added.count > 0 || members.removed.count > 0 || members.changed.count > 0)) {
    parts.push(`interface +${members.added.count}/-${members.removed.count}/~${members.changed.count}`)
  }
  if (text !== null && (text.added.count > 0 || text.removed.count > 0)) {
    parts.push(`text +${text.added.count}/-${text.removed.count}`)
  }
  parts.push(
    block.faces.state === 'known'
      ? `faces: ${block.faces.changed.length === 0 ? 'none changed' : block.faces.changed.join(', ')}`
      : 'faces: unknown (no ledger on both sides)',
  )
  lines.push(parts.join('; '))
  return lines
}
