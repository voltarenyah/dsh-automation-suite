/**
 * Which device a version-store question is about, resolved **without TIA**.
 *
 * The version store must answer history questions while TIA is closed, so it
 * cannot go through `resolveDevice` (which asks the open project). The source
 * tree already names its device directories: `source/<device>/_evidence.json`.
 *
 * @module dsh-engineering-context/version/device
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { PluginConfig } from '../config.js'
import type { DeviceInfo } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalizeLoose, folderName } from '../paths.js'

/**
 * Resolve the device directory from the source tree.
 *
 * @param config - the resolved plugin configuration.
 * @param root - the workspace root.
 * @param requested - the device name the caller named, if any.
 * @returns the device and its absolute directory.
 * @throws {EngineeringContextError} when no ledger exists, or several devices
 *   exist and none was named.
 */
export async function resolveSourceDevice(
  config: PluginConfig,
  root: string,
  requested?: string,
): Promise<DeviceInfo> {
  const sourceRoot = await canonicalizeLoose(join(root, config.sourceDirName))
  let entries: string[] = []
  try {
    const dirents = await readdir(sourceRoot, { withFileTypes: true })
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    entries = []
  }

  const candidates = entries
    .filter((name) => existsSync(join(sourceRoot, name, '_evidence.json')))
    .sort((left, right) => left.localeCompare(right))

  if (candidates.length === 0) {
    throw new EngineeringContextError(
      'device_not_found',
      `No device source tree with an evidence ledger under ${sourceRoot}. Run create_engineering_project (or a sync) first, or check ${config.sourceDirName}/.`,
      { sourceRoot },
    )
  }

  if (requested !== undefined && requested.length > 0) {
    const wanted = folderName(requested)
    const match = candidates.find((name) => name.toLowerCase() === wanted.toLowerCase())
    if (match === undefined) {
      throw new EngineeringContextError(
        'device_not_found',
        `No source tree for device "${requested}" under ${sourceRoot}; found: ${candidates.join(', ')}.`,
        { sourceRoot, found: candidates },
      )
    }
    return {
      device: match,
      software: '',
      directory: join(sourceRoot, match),
      sourceRoot,
    }
  }

  if (candidates.length > 1) {
    throw new EngineeringContextError(
      'multiple_plc_unsupported',
      `The workspace holds ${candidates.length} device source trees (${candidates.join(', ')}). Pass the device name.`,
      { devices: candidates },
    )
  }

  const only = candidates[0] as string
  return {
    device: only,
    software: '',
    directory: join(sourceRoot, only),
    sourceRoot,
  }
}
