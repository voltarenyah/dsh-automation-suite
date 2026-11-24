/**
 * Which PLC a workspace's source tree belongs to, and where that tree lives.
 *
 * **Two resolvers, because two kinds of caller need different things** (R1):
 *
 * - {@link resolveDeviceFromTia} asks the **open project**. `project_sync`,
 *   `project_status` and the handoff tools need it: they talk to TIA anyway, and
 *   the open session is the authority on which device is being edited.
 * - {@link resolveDeviceFromDisk} reads the **workspace**: the creation index
 *   (`source/_dsh-engineering-context.json`) first, then the evidence ledgers
 *   under `source/<device>/`. `project_commit` (and `project_diff` /
 *   `project_history` through the version store) needs this one — recording
 *   history is a git + filesystem operation and must work with TIA closed, or
 *   with the interface plugin not installed at all.
 *
 * {@link crossCheckDeviceWithTia} is the optional bridge between them: when the
 * service happens to be present, a commit **reports** that the open project
 * disagrees with the workspace and then does the commit anyway. Refusing here
 * would put "TIA must be open" straight back into the history path.
 *
 * One workspace manages one project; the first slice supports **one PLC** per
 * project. Naming the device (`device:` argument) resolves the multi-device case
 * instead of refusing it: a workspace may legitimately hold several device trees
 * after a handoff import, and git does not care.
 *
 * @module dsh-engineering-context/device
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { normalizeSession, type EngineeringAccessLike, type TiaSession } from './access.js'
import {
  EVIDENCE_FILE,
  sourceDirectoryPath,
  sourceIndexPath,
  type PluginConfig,
} from './config.js'
import { EngineeringContextError } from './errors.js'
import { canonicalizeLoose, folderName, isInside } from './paths.js'
import { assertInsideWith, type ResolvedScope } from './scope.js'

/** The one PLC a sync/status call works on. */
export interface DeviceInfo {
  device: string
  software: string
  /** Absolute directory of this device's source tree. */
  directory: string
  /** Absolute source-tree root (the parent of every device directory). */
  sourceRoot: string
}

/** Where a disk resolution got its device list. */
export type DeviceOrigin = 'index' | 'evidence'

/** A disk resolution, plus the provenance a caller can report. */
export interface DiskDeviceResolution {
  device: DeviceInfo
  /** `index` = `source/_dsh-engineering-context.json`; `evidence` = a directory scan. */
  origin: DeviceOrigin
  /** Non-fatal facts (unreadable index, a hint that pointed outside `source/`). */
  warnings: string[]
}

interface IndexDevice {
  device?: unknown
  software?: unknown
  directory?: unknown
}

/** One device the workspace already describes. */
interface Candidate {
  /** The TIA device name when the index knows it, the directory name otherwise. */
  name: string
  /** The software (program) name, empty when it is not recorded. */
  software: string
  /** Directory recorded by create/sync: a hint, never authority. */
  hint: string | null
}

/**
 * Compare two device identifiers the way the filesystem does.
 *
 * The same PLC is called `Sino_PEI` in TIA and `Sino_PEI` (or `Sino-PEI`, or
 * `Sino PEI`) as a directory, because the directory name is sanitised by
 * `folderName()`. Comparing the folder forms case-insensitively is what both the
 * index and the directory scan can agree on.
 *
 * @param left - one identifier.
 * @param right - the other identifier.
 * @returns whether they name the same device.
 */
function sameDevice(left: string, right: string): boolean {
  return folderName(left).toLowerCase() === folderName(right).toLowerCase()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the device list the creation index records.
 *
 * A missing index is **not** an error (a workspace can predate it, or the index
 * can be git-ignored); an unreadable one is only a warning, because the ledgers
 * on disk are enough to resolve the device.
 *
 * @param config - the resolved plugin configuration.
 * @param root - the workspace root.
 * @returns the entries, plus a warning when the file exists but cannot be used.
 */
async function readIndexDevices(
  config: PluginConfig,
  root: string,
): Promise<{ entries: Candidate[]; warning: string | null }> {
  const path = sourceIndexPath(config, root)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { entries: [], warning: null }
  }

  try {
    const parsed = JSON.parse(raw) as { devices?: unknown }
    if (!Array.isArray(parsed.devices)) return { entries: [], warning: null }
    const entries: Candidate[] = []
    for (const value of parsed.devices) {
      const entry = value as IndexDevice
      if (typeof entry !== 'object' || entry === null) continue
      if (typeof entry.device !== 'string' || entry.device.length === 0) continue
      entries.push({
        name: entry.device,
        software: typeof entry.software === 'string' ? entry.software : '',
        hint:
          typeof entry.directory === 'string' && entry.directory.length > 0 ? entry.directory : null,
      })
    }
    return { entries, warning: null }
  } catch (error) {
    return {
      entries: [],
      warning:
        `The source index ${path} is not readable JSON (${messageOf(error)}); ` +
        'the device was resolved from the evidence ledgers under source/ instead.',
    }
  }
}

/**
 * Directory names under `source/` that carry an evidence ledger.
 *
 * @param config - the resolved plugin configuration.
 * @param sourceRoot - the canonical source-tree root.
 * @returns the candidate directory names, sorted.
 */
async function evidenceDirectories(config: PluginConfig, sourceRoot: string): Promise<string[]> {
  let names: string[] = []
  try {
    const dirents = await readdir(sourceRoot, { withFileTypes: true })
    names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    names = []
  }
  return names
    .filter((name) => existsSync(join(sourceRoot, name, EVIDENCE_FILE)))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Resolve the device **from the workspace**, without talking to TIA.
 *
 * Order: the creation index (it also carries the software name and the directory
 * the export actually wrote), then a scan for `source/<dir>/_evidence.json`.
 * Neither source is an authority over the files: a directory hint that points
 * outside `source/` is ignored with a warning, and a missing hint falls back to
 * the same deterministic directory the export uses.
 *
 * @param config - the resolved plugin configuration.
 * @param root - the workspace root.
 * @param requested - the device the caller named, if any (name or folder name).
 * @returns the device, its provenance, and any non-fatal warning.
 * @throws {EngineeringContextError} `device_not_found` when nothing usable exists
 *   (or the named device does not), `multiple_plc_unsupported` when several exist
 *   and none was named.
 */
export async function resolveDeviceFromDisk(
  config: PluginConfig,
  root: string,
  requested?: string,
): Promise<DiskDeviceResolution> {
  const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(config, root))
  const warnings: string[] = []

  const index = await readIndexDevices(config, root)
  if (index.warning !== null) warnings.push(index.warning)

  let origin: DeviceOrigin
  let candidates: Candidate[]
  if (index.entries.length > 0) {
    origin = 'index'
    candidates = index.entries
  } else {
    origin = 'evidence'
    const names = await evidenceDirectories(config, sourceRoot)
    candidates = names.map((name) => ({ name, software: '', hint: null }))
  }

  if (candidates.length === 0) {
    throw new EngineeringContextError(
      'device_not_found',
      `No device source tree with an evidence ledger under ${sourceRoot}. Run create_engineering_project ` +
        '(or a sync) first, or check source/.',
      { sourceRoot },
    )
  }

  let chosen: Candidate | undefined
  const named = typeof requested === 'string' ? requested.trim() : ''
  if (named.length > 0) {
    chosen = candidates.find(
      (candidate) =>
        sameDevice(candidate.name, named) ||
        (candidate.hint !== null && sameDevice(basename(candidate.hint), named)),
    )
    if (chosen === undefined) {
      throw new EngineeringContextError(
        'device_not_found',
        `No source tree for device "${named}" under ${sourceRoot}; found: ${candidates
          .map((candidate) => candidate.name)
          .join(', ')}.`,
        { sourceRoot, found: candidates.map((candidate) => candidate.name) },
      )
    }
  } else if (candidates.length > 1) {
    throw new EngineeringContextError(
      'multiple_plc_unsupported',
      `The workspace holds ${candidates.length} device source trees (${candidates
        .map((candidate) => candidate.name)
        .join(', ')}). Pass the device name.`,
      { devices: candidates.map((candidate) => candidate.name) },
    )
  } else {
    chosen = candidates[0]
  }

  if (chosen === undefined) {
    // Unreachable: `candidates` is non-empty and the branches above always pick one.
    throw new EngineeringContextError('device_not_found', `No device source tree under ${sourceRoot}.`, {
      sourceRoot,
    })
  }

  const fallback = await canonicalizeLoose(join(sourceRoot, folderName(chosen.name)))
  let directory = fallback
  if (chosen.hint !== null) {
    const absolute = isAbsolute(chosen.hint) ? chosen.hint : join(sourceRoot, chosen.hint)
    const hinted = await canonicalizeLoose(absolute)
    // A hint is only usable when it stays inside `source/` **and** actually holds
    // a ledger: a copied workspace can carry an absolute path from another
    // machine, and an older index can point at a directory that has since moved.
    if (isInside(sourceRoot, hinted) && existsSync(join(hinted, EVIDENCE_FILE))) {
      directory = hinted
    } else {
      warnings.push(
        `The source index pointed the device "${chosen.name}" at ${chosen.hint}, which is not a usable device ` +
          `directory under ${sourceRoot}; ${fallback} was used instead.`,
      )
    }
  }

  return {
    device: {
      device: chosen.name,
      software: chosen.software,
      directory,
      sourceRoot,
    },
    origin,
    warnings,
  }
}

/** The device directory recorded by `create_engineering_project`, if any. */
async function recordedDirectory(
  config: PluginConfig,
  root: string,
  device: string,
  software: string,
): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(sourceIndexPath(config, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { devices?: unknown }
    if (!Array.isArray(parsed.devices)) return null
    for (const value of parsed.devices) {
      const entry = value as IndexDevice
      if (typeof entry !== 'object' || entry === null) continue
      if (entry.device !== device) continue
      if (typeof entry.software === 'string' && entry.software !== software) continue
      if (typeof entry.directory !== 'string' || entry.directory.length === 0) continue
      return entry.directory
    }
  } catch {
    return null
  }
  return null
}

/**
 * Resolve the PLC and its source directory **from the open TIA project**.
 *
 * This is the resolver for the tools that talk to TIA anyway: sync rewrites the
 * tree from the open project, status reports whether that project still matches
 * the ledger, and the handoff tools archive it. It refuses rather than guessing:
 * no controller, no open project, no PLC, or more than one PLC all throw — the
 * last one with `multiple_plc_unsupported`, which tells the caller to name the
 * device (the disk resolver honours that name).
 *
 * @param scope - the resolved workspace scope.
 * @param access - the interface plugin's service.
 * @param exec - the per-call execution context (for cancellation).
 * @returns the device and its absolute source directory.
 * @throws {EngineeringContextError} when no project/PLC exists, or when more than
 *   one PLC is open.
 */
export async function resolveDeviceFromTia(
  scope: ResolvedScope,
  access: EngineeringAccessLike,
  exec: ToolRunContext,
): Promise<DeviceInfo> {
  let raw: unknown
  try {
    raw = await access.readTiaSession({ signal: exec.signal })
  } catch (error) {
    throw new EngineeringContextError(
      'tia_unreachable',
      `The TIA interface plugin could not be reached: ${messageOf(error)}`,
      {},
    )
  }
  const session = normalizeSession(raw)
  if (!session.running) {
    throw new EngineeringContextError(
      'tia_controller_not_running',
      session.reason ?? 'The TIA Openness controller is not running, so no project is open.',
      { reason: session.reason },
    )
  }
  if (!session.projectOpen) {
    throw new EngineeringContextError(
      'tia_project_not_open',
      'TIA Portal has no project open. Open the workspace project (or call create_engineering_project) first.',
      { reason: session.reason },
    )
  }
  if (session.software.length === 0) {
    throw new EngineeringContextError('device_not_found', 'The open project contains no PLC software.', {
      projectName: session.projectName,
    })
  }
  if (session.software.length > 1) {
    throw new EngineeringContextError(
      'multiple_plc_unsupported',
      `The open project contains ${session.software.length} PLCs (${session.software
        .map((entry) => entry.device)
        .join(', ')}). This first slice syncs one PLC per workspace; split the project or pass the device name.`,
      { devices: session.software.map((entry) => entry.device) },
    )
  }

  const plc = session.software[0]
  if (plc === undefined) {
    throw new EngineeringContextError('device_not_found', 'The open project contains no PLC software.', {
      projectName: session.projectName,
    })
  }
  const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(scope.config, scope.workspace.path))
  const recorded = await recordedDirectory(scope.config, scope.workspace.path, plc.device, plc.software)
  let directory: string
  if (recorded !== null) {
    const absolute = isAbsolute(recorded) ? recorded : join(sourceRoot, recorded)
    const candidate = await canonicalizeLoose(absolute)
    if (isInside(sourceRoot, candidate)) {
      directory = candidate
    } else {
      // The index may carry an absolute path from a workspace that has since been
      // moved or copied. It is a hint, not authority: fall back to the same
      // deterministic directory the export itself uses.
      directory = await canonicalizeLoose(join(sourceRoot, folderName(plc.device)))
    }
  } else {
    directory = await canonicalizeLoose(join(sourceRoot, folderName(plc.device)))
  }
  assertInsideWith(scope.config, scope.workspace.path, directory, 'The device directory')

  return {
    device: plc.device,
    software: plc.software,
    directory,
    sourceRoot,
  }
}

/**
 * Compare a disk-resolved device with whatever the open TIA project says.
 *
 * **Warnings only.** The caller has already decided to act on the source tree;
 * this function exists so the user learns that the open project is a different
 * one, instead of discovering it in the history. Every failure mode (no service,
 * no controller, no project, several PLCs) is a sentence, never an exception.
 *
 * @param access - the interface plugin's service.
 * @param device - the device resolved from the workspace.
 * @param signal - cancellation from the calling tool.
 * @returns zero warnings when TIA agrees or is not reachable; otherwise one line
 *   naming both sides.
 */
export async function crossCheckDeviceWithTia(
  access: EngineeringAccessLike,
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<string[]> {
  let session: TiaSession
  try {
    session = normalizeSession(await access.readTiaSession({ signal }))
  } catch (error) {
    return [`TIA could not be reached (${messageOf(error)}); the device was taken from the source tree.`]
  }
  if (!session.running) {
    return ['TIA is not running; the device was taken from the source tree.']
  }
  if (!session.projectOpen) {
    return ['TIA has no project open; the device was taken from the source tree.']
  }
  const opened = session.software
  if (opened.length === 0) {
    return ['TIA has no PLC software open; the device was taken from the source tree.']
  }
  if (opened.length > 1) {
    return [
      `TIA has ${opened.length} PLCs open (${opened.map((entry) => entry.device).join(', ')}); ` +
        `this workspace records "${device.device}" from source/.`,
    ]
  }
  const plc = opened[0]
  if (plc === undefined) return []
  if (!sameDevice(plc.device, device.device)) {
    return [
      `TIA has PLC "${plc.device}" open, but this workspace's source tree is "${device.device}". ` +
        'The commit records the source tree; switch projects if that is not what you meant.',
    ]
  }
  if (device.software.length > 0 && plc.software.length > 0 && plc.software !== device.software) {
    return [
      `TIA has software "${plc.software}" open, but this workspace records "${device.software}". ` +
        'The commit records the source tree.',
    ]
  }
  return []
}
