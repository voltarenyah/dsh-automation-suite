/**
 * Which PLC this workspace's source tree belongs to.
 *
 * One workspace manages one project; the first slice supports **one PLC** per
 * project. The device directory is the one the export already wrote
 * (`source/<device>/`), found through the creation index when it exists and
 * derived from the device name otherwise.
 *
 * @module dsh-engineering-context/device
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { normalizeSession, type EngineeringAccessLike } from './access.js'
import { sourceDirectoryPath, sourceIndexPath, type PluginConfig } from './config.js'
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

interface IndexDevice {
  device?: unknown
  software?: unknown
  directory?: unknown
}

/** The device directory recorded by `create_engineering_project`, if any. */
async function recordedDirectory(config: PluginConfig, root: string, device: string, software: string): Promise<string | null> {
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
 * Resolve the PLC and its source directory.
 *
 * @param scope - the resolved workspace scope.
 * @param access - the interface plugin's service.
 * @param exec - the per-call execution context (for cancellation).
 * @returns the device and its absolute source directory.
 * @throws {EngineeringContextError} when no project/PLC exists, or when more than
 *   one PLC is open (the first slice refuses rather than guessing).
 */
export async function resolveDevice(
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
      `The TIA interface plugin could not be reached: ${error instanceof Error ? error.message : String(error)}`,
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
        .join(', ')}). This first slice syncs one PLC per workspace; split the project or wait for multi-device support.`,
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