/**
 * The shell's "default workspace" (first-use Workspace) is a product concept
 * this distribution does not want. The registry has **no getter** for it and no
 * "do not create" switch, so the two supported levers are:
 *
 *  1. identify it from the durable registry file (`global.defaultWorkspaceId`);
 *  2. unregister it through `workspaceRegistry.delete` — files and session logs
 *     stay, its sessions become ungrouped, and the durable marker keeps the
 *     shell's `initializeDefault` from creating a new one.
 *
 * This module owns both. Reading `workspace.json` is deliberate: the registry
 * service exposes creation/deletion but not the first-use identity, and this is
 * a one-shot cleanup, not a per-refresh scan.
 *
 * @module dsh-ui-project-dashboard/default-workspace
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The registry surface this module needs. */
export interface WorkspaceRegistryLike {
  list(): Array<{ id: string }>
  delete(id: string): Promise<boolean>
}

/** What the page needs to know about the default workspace. */
export interface DefaultWorkspaceStatus {
  /** Recorded first-use workspace id, or null when the registry never made one. */
  id: string | null
  /** Whether that id is still registered (and therefore visible in the sidebar). */
  registered: boolean
}

/** Outcome of the one-click removal. */
export interface PruneResult {
  deleted: boolean
  reason?: 'not-initialized' | 'no-registry' | 'not-registered' | 'delete-failed'
}

/**
 * Read the recorded first-use workspace id from the registry file.
 *
 * @param home - the resolved DSH home.
 * @returns the id, or null when the file is absent/unreadable/has no marker.
 */
export async function readDefaultWorkspaceId(home: string): Promise<string | null> {
  try {
    const text = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
    const document = JSON.parse(text) as { global?: { defaultWorkspaceId?: unknown } }
    const id = document?.global?.defaultWorkspaceId
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * Whether the recorded default workspace is still registered.
 *
 * @param home - the resolved DSH home.
 * @param registry - the workspace registry, when present.
 * @returns the status the page renders.
 */
export async function defaultWorkspaceStatus(
  home: string,
  registry: WorkspaceRegistryLike | undefined,
): Promise<DefaultWorkspaceStatus> {
  const id = await readDefaultWorkspaceId(home)
  if (id === null) return { id: null, registered: false }
  let registered = false
  try {
    registered = registry !== undefined && registry.list().some((entity) => entity.id === id)
  } catch {
    registered = false
  }
  return { id, registered }
}

/**
 * Unregister the default workspace. Non-destructive: the directory and every
 * session log stay; sessions show up under Ungrouped.
 *
 * @param home - the resolved DSH home.
 * @param registry - the workspace registry, when present.
 * @returns whether something was deleted, and why not otherwise.
 */
export async function pruneDefaultWorkspace(
  home: string,
  registry: WorkspaceRegistryLike | undefined,
): Promise<PruneResult> {
  const id = await readDefaultWorkspaceId(home)
  if (id === null) return { deleted: false, reason: 'not-initialized' }
  if (registry === undefined) return { deleted: false, reason: 'no-registry' }
  try {
    if (!registry.list().some((entity) => entity.id === id)) return { deleted: false, reason: 'not-registered' }
    const deleted = await registry.delete(id)
    return deleted ? { deleted: true } : { deleted: false, reason: 'delete-failed' }
  } catch {
    return { deleted: false, reason: 'delete-failed' }
  }
}
