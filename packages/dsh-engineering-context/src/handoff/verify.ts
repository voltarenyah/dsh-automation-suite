/**
 * Prove that a returned marker describes the committed base it names.
 *
 * The marker is untrusted input from another machine. Its `git.head` is only a
 * claim until we read that commit's `_evidence.json` out of **this** repository
 * and compare it with the ledger embedded in the marker. A marker that does not
 * match is not repaired or guessed at: the import refuses, because a wrong base
 * is worse than no import.
 *
 * v1 also refuses a workspace that moved past the handoff base. That is the
 * "do not edit this source tree while the project is out" rule; merging local and
 * returned changes is a later, deliberately separate feature.
 *
 * @module dsh-engineering-context/handoff/verify
 */

import type { DeviceInfo } from '../device.js'
import { EngineeringContextError } from '../errors.js'
import { canonicalJson, record, sameJson, sourceIdentityOf, text } from './marker.js'
import { commitMeta, gitPath, headCommit, runGit, showFileAtRevision, statusPaths } from '../git.js'
import { localStateDirectoryPath, type PluginConfig } from '../config.js'
import type { HandoffMarker, HandoffMarkerDevice } from './types.js'

/** The verified base facts. */
export interface VerifiedBase {
  head: string
  branch: string | null
  currentBranch: string | null
  device: HandoffMarkerDevice
  evidencePath: string
  /** The committed ledger text, for a byte-level repair copy if one is ever needed. */
  evidenceText: string
}

/** Find the marker part for the device this workspace tracks. */
export function markerDeviceFor(marker: HandoffMarker, device: DeviceInfo): HandoffMarkerDevice {
  if (marker.devices.length !== 1) {
    throw new EngineeringContextError(
      'handoff_marker_invalid',
      `This archive carries ${marker.devices.length} PLC devices; this build imports one PLC per workspace.`,
      { devices: marker.devices.map((entry) => entry.device) },
    )
  }
  const found = marker.devices[0]
  if (found === undefined || found.device !== device.device || found.software !== device.software) {
    throw new EngineeringContextError(
      'handoff_project_mismatch',
      `The handoff was made for ${marker.devices.map((entry) => entry.device).join(', ')}, but this workspace tracks ` +
        `${device.device} / ${device.software}.`,
      { markerDevices: marker.devices.map((entry) => entry.device), workspaceDevice: device.device },
    )
  }
  return found
}

/** The current branch name, or null when HEAD is detached/unborn. */
async function currentBranch(root: string): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value.length === 0 || value === 'HEAD' ? null : value
}

/**
 * Read the committed ledger at one revision.
 *
 * @param root - the workspace root.
 * @param head - the marker's base commit.
 * @param device - the device directory.
 */
export async function committedEvidence(
  root: string,
  head: string,
  device: DeviceInfo,
): Promise<{ text: string; parsed: Record<string, unknown>; path: string }> {
  const path = `${gitPath(root, device.directory)}/_evidence.json`
  const raw = await showFileAtRevision(root, head, path)
  if (raw === null) {
    throw new EngineeringContextError(
      'handoff_provenance_invalid',
      `Commit ${head} does not contain ${path}, so the handoff base cannot be verified.`,
      { head, path },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new EngineeringContextError('handoff_provenance_invalid', `The evidence ledger at ${head}:${path} is not JSON.`, {
      head,
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const rootObject = record(parsed)
  if (rootObject === null) {
    throw new EngineeringContextError('handoff_provenance_invalid', `The evidence ledger at ${head}:${path} is not an object.`, {
      head,
      path,
    })
  }
  return { text: raw, parsed: rootObject, path }
}

/**
 * Verify the marker's provenance, the workspace's position and the source tree's
 * cleanliness.
 *
 * @param root - the workspace root.
 * @param marker - the marker read from the archive.
 * @param device - the PLC this workspace tracks (resolved from the old project).
 * @param options - `allowAdvanced` is reserved for a later merge feature; v1 passes false.
 */
export async function verifyMarkerAgainstGit(
  root: string,
  marker: HandoffMarker,
  device: DeviceInfo,
  options: { allowAdvanced?: boolean } = {},
): Promise<VerifiedBase> {
  const part = markerDeviceFor(marker, device)
  const base = await commitMeta(root, marker.git.head)
  if (base === null) {
    throw new EngineeringContextError(
      'handoff_provenance_invalid',
      `The handoff base commit ${marker.git.head} does not exist in this repository. The archive cannot be tied to a ` +
        'known source state.',
      { head: marker.git.head },
    )
  }
  const head = await headCommit(root)
  if (head !== marker.git.head && options.allowAdvanced !== true) {
    throw new EngineeringContextError(
      'handoff_workspace_advanced',
      `The handoff was made at ${marker.git.head}, but this workspace is at ${head ?? 'no commit'}. ` +
        'v1 does not merge a returned project with local changes. Return the workspace to that commit (or import in a ' +
        'workspace that is still at it) before importing.',
      { base: marker.git.head, head },
    )
  }
  const dirty = await statusPaths(root, [gitPath(root, device.directory)])
  if (dirty.length > 0) {
    throw new EngineeringContextError(
      'handoff_source_dirty',
      `The source tree ${gitPath(root, device.directory)} has uncommitted changes, so the handoff base is not the tree ` +
        'on disk. Commit or discard them before importing.',
      { base: marker.git.head, paths: dirty },
    )
  }

  const committed = await committedEvidence(root, marker.git.head, device)
  if (!sameJson(committed.parsed, part.evidence)) {
    throw new EngineeringContextError(
      'handoff_provenance_invalid',
      `The marker's evidence does not match ${committed.path} at ${marker.git.head}. The archive was not made from that ` +
        'committed state (or the marker was altered).',
      { base: marker.git.head, path: committed.path },
    )
  }
  const recomputed = sourceIdentityOf(part.evidence)
  if (recomputed !== part.sourceIdentity) {
    throw new EngineeringContextError(
      'handoff_provenance_invalid',
      `The marker's source identity ${part.sourceIdentity} does not match its own evidence (${recomputed}).`,
      { base: marker.git.head, device: part.device },
    )
  }
  const canonical = canonicalJson(part.evidence)
  if (canonical.length === 0) {
    throw new EngineeringContextError('handoff_provenance_invalid', 'The marker embeds an empty evidence ledger.', {
      base: marker.git.head,
    })
  }
  if (text(part.evidence['plcChecksum']) !== part.plcChecksum) {
    throw new EngineeringContextError(
      'handoff_provenance_invalid',
      'The marker PLC checksum does not match the checksum inside its own evidence ledger.',
      { base: marker.git.head, device: part.device },
    )
  }

  return {
    head: marker.git.head,
    branch: marker.git.branch,
    currentBranch: await currentBranch(root),
    device: part,
    evidencePath: committed.path,
    evidenceText: committed.text,
  }
}

/** The backup root for old projects, shared by import and status. */
export function handoffBackupRoot(config: PluginConfig, root: string): string {
  return `${localStateDirectoryPath(config, root)}/handoff-backups`
}

