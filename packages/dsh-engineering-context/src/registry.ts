/**
 * The engineering project registry: `_dsh-eng/projects.json` inside the
 * workspace.
 *
 * This file is the single source of "which projects exist here and which one is
 * selected" (docs/decisions.md N3 — one registry at the workspace root, one
 * subdirectory per project for the rest of the state, so two pointers can never
 * disagree). It is written atomically, and it is read defensively: a registry
 * that does not validate is reported as such and **never** rewritten, because
 * silently rebuilding it would discard registrations the user made.
 *
 * @module dsh-engineering-context/registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { registryRelativePath, type PluginConfig } from './config.js'
import { fromPortable } from './paths.js'

/** Schema version of the registry document. */
export const REGISTRY_SCHEMA_VERSION = 1

/** One registered engineering project, as stored on disk. */
export interface ProjectRecord {
  /** Stable id; also the directory name under the content and state roots. */
  id: string
  /** Human title. */
  title: string
  /**
   * Absolute path of the user's own source `.ap17`. Provenance only: after a
   * successful `adopt` the plugin never reads or writes it again
   * (`docs/PATH-RULES.md` §3).
   */
  source: string | null
  /** Working copy, portable (relative to the workspace root, forward slashes). */
  work: string
  /** Export directory, portable. */
  export: string
  /** When the registration was created (ISO-8601). */
  createdAt: string
  /** When the working copy was materialized (ISO-8601), or null. */
  adoptedAt: string | null
}

/** The `_dsh-eng/projects.json` document. */
export interface RegistryFile {
  schemaVersion: number
  /** Canonical workspace path this registry was created in. */
  workspacePath: string
  /** The selected project id, or null. */
  current: string | null
  /** Registered projects, in registration order. */
  projects: ProjectRecord[]
}

/** Outcome of reading the registry: absent, unusable, or parsed. */
export type RegistryState =
  | { status: 'missing'; file: string }
  | { status: 'invalid'; file: string; reason: string }
  | { status: 'ok'; file: string; document: RegistryFile }

/**
 * Absolute path of the registry file for one workspace root.
 * @param config - the resolved configuration.
 * @param root - the canonical workspace root.
 */
export function registryFile(config: PluginConfig, root: string): string {
  return fromPortable(root, registryRelativePath(config))
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['title'] === 'string' &&
    (record['source'] === null || typeof record['source'] === 'string') &&
    typeof record['work'] === 'string' &&
    typeof record['export'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    (record['adoptedAt'] === null || typeof record['adoptedAt'] === 'string')
  )
}

/**
 * Validate a parsed registry document.
 *
 * @param parsed - the result of `JSON.parse`.
 * @returns the document, or a human-readable reason it is unusable.
 */
function validateDocument(parsed: unknown): RegistryFile | string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the document is not a JSON object'
  const document = parsed as Record<string, unknown>

  if (document['schemaVersion'] !== REGISTRY_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${JSON.stringify(document['schemaVersion'])} (this plugin writes ${REGISTRY_SCHEMA_VERSION})`
  }
  if (typeof document['workspacePath'] !== 'string' || document['workspacePath'].length === 0) {
    return 'workspacePath is missing'
  }
  if (document['current'] !== null && typeof document['current'] !== 'string') {
    return 'current is neither a string nor null'
  }
  const projects = document['projects']
  if (!Array.isArray(projects)) return 'projects is not an array'
  const bad = projects.findIndex((entry) => !isProjectRecord(entry))
  if (bad >= 0) return `projects[${bad}] is not a project record`
  const ids = new Set<string>()
  for (const project of projects as ProjectRecord[]) {
    if (ids.has(project.id)) return `project id '${project.id}' appears twice`
    ids.add(project.id)
  }
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspacePath: document['workspacePath'],
    current: document['current'] as string | null,
    projects: projects as ProjectRecord[],
  }
}

/**
 * Read the registry of one workspace.
 *
 * @param config - the resolved configuration.
 * @param root - the canonical workspace root.
 * @returns the state; `invalid` carries the reason and leaves the file alone.
 */
export async function readRegistry(config: PluginConfig, root: string): Promise<RegistryState> {
  const file = registryFile(config, root)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing', file }
    return { status: 'invalid', file, reason: `the registry could not be read (${code ?? String(error)})` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: 'invalid', file, reason: `the registry is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }

  const validated = validateDocument(parsed)
  if (typeof validated === 'string') return { status: 'invalid', file, reason: validated }
  return { status: 'ok', file, document: validated }
}

/**
 * Write the registry atomically: a sibling temporary file, then a rename.
 *
 * A rename within one directory is atomic, so a reader (or a crash) never sees a
 * half-written registry. The temporary name is fixed rather than random on
 * purpose: a leftover temp file is then recognizable as this plugin's garbage
 * instead of accumulating one file per crash.
 *
 * @param config - the resolved configuration.
 * @param root - the canonical workspace root.
 * @param document - the document to persist.
 * @returns the absolute path written.
 */
export async function writeRegistry(
  config: PluginConfig,
  root: string,
  document: RegistryFile,
): Promise<string> {
  const file = registryFile(config, root)
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `${'.projects.json'}.tmp`)
  await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return file
}

/**
 * The selected project, or the single one when nothing is selected.
 *
 * Being explicit about the ambiguous case matters: silently picking the first of
 * several projects is exactly the "which version is this answer about?" failure
 * the whole plugin exists to prevent.
 *
 * @param document - a validated registry document.
 * @returns `{ record }`, `{ none: true }` when there is no project at all, or
 *   `{ ambiguous: true }` when several exist and none is selected.
 */
export function selectProject(
  document: RegistryFile,
): { record: ProjectRecord } | { none: true } | { ambiguous: true } {
  if (document.current !== null) {
    const selected = document.projects.find((project) => project.id === document.current)
    if (selected !== undefined) return { record: selected }
  }
  if (document.projects.length === 0) return { none: true }
  if (document.projects.length === 1) {
    const only = document.projects[0]
    if (only !== undefined) return { record: only }
  }
  return { ambiguous: true }
}
