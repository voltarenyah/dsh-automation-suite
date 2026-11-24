/**
 * Which PLC a workspace's source tree belongs to, resolved **without TIA**.
 *
 * This is the version-control half of the resolver that used to live in
 * `@automation-suite/engineering-context` (D41). It reads the workspace:
 *
 *   `source/_dsh-engineering-context.json`  → the creation index (device,
 *                                             software, the directory the export
 *                                             actually wrote)
 *   `source/<device>/_evidence.json`        → the fallback, when there is no index
 *
 * Nothing here opens a project, and nothing here needs the interface plugin to be
 * installed: recording history is a git + filesystem operation.
 *
 * {@link crossCheckDeviceWithTia} is the optional bridge, called **only** when the
 * composition happens to have `engineeringAccess`. A disagreement between the open
 * project and this workspace is news, never a refusal — refusing would put "TIA
 * must be open" straight back into the history path.
 *
 * @module dsh-engineering-version-control/device
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { normalizeSession, type EngineeringAccessLike, type TiaSession } from './access.js'
import { EVIDENCE_FILE, sourceDirectoryPath, sourceIndexPath, type PluginConfig } from './config.js'
import { EngineeringContextError } from './errors.js'
import { canonicalizeLoose, folderName, isInside } from './paths.js'

/** The one PLC a commit or a history query works on. */
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
  /** Non-fatal facts (unreadable index, a hint that is not a usable device directory). */
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
 * The same PLC is called `Sino_PEI` in TIA and `Sino_PEI` (or `Sino-PEI`) as a
 * directory, because the directory name is sanitised by `folderName()`.
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
 * @param sourceRoot - the canonical source-tree root.
 * @returns the candidate directory names, sorted.
 */
async function evidenceDirectories(sourceRoot: string): Promise<string[]> {
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
 * Neither source is an authority over the files: a directory hint that is not a
 * usable device directory is ignored with a warning, and a missing hint falls
 * back to the directory name the export uses.
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
    const names = await evidenceDirectories(sourceRoot)
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

/**
 * Compare a disk-resolved device with whatever the open TIA project says.
 *
 * **Warnings only.** The caller has already decided to act on the source tree;
 * this function exists so the user learns that the open project is a different
 * one, instead of discovering it in the history. Every failure mode (no
 * controller, no project, several PLCs) is a sentence, never an exception.
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
