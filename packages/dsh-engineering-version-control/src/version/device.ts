/**
 * Which device a version-store question is about, resolved **without TIA**.
 *
 * The version store must answer history questions while TIA is closed, so it
 * cannot go through `resolveDeviceFromTia` (which asks the open project). This
 * module is a thin, stable alias for {@link resolveDeviceFromDisk}: the version
 * tools keep their own import path and error wording, while the device logic
 * lives in one place (`src/device.ts`) so `project_commit` reads the workspace
 * exactly the same way a history query does.
 *
 * @module dsh-engineering-context/version/device
 */

import type { PluginConfig } from '../config.js'
import { resolveDeviceFromDisk, type DeviceInfo } from '../device.js'

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
  const resolved = await resolveDeviceFromDisk(config, root, requested)
  return resolved.device
}
