/**
 * One commit: SOURCE → git, in two steps the model can separate.
 *
 * `project_sync` promotes the exported files and rewrites the ledgers, but it no
 * longer commits: a version change is only worth a commit once a human has seen
 * what it contains. This module plans that commit (which paths are dirty, what
 * message would be recorded) and runs it under the workspace lock, appending the
 * same trailers `project_sync` used to write so the history stays machine-readable.
 *
 * The message is the caller's, because only the caller knows *why* the change
 * exists. Everything the plugin knows for certain — device, checksum, state id,
 * manifest state — goes into the trailer block, so a message written by an agent
 * still carries verifiable facts.
 *
 * @module dsh-engineering-context/commit
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { evidencePathForDevice } from './config.js'
import type { DeviceInfo } from './device.js'
import { EngineeringContextError } from './errors.js'
import { readEvidence, type EvidenceDocument } from './evidence.js'
import { commitPaths, ensureRepository, gitPath, porcelainPaths, statusPaths, type GitCommit } from './git.js'
import { withLock } from './lock.js'
import type { ResolvedScope } from './scope.js'

/** The longest message this tool accepts, in characters. */
export const MAX_COMMIT_MESSAGE_CHARS = 8000

/** What one planned commit would record. */
export interface CommitPlan {
  device: DeviceInfo
  /** The device directory relative to the workspace root. */
  relative: string
  /** Workspace-relative paths `git` reports as dirty inside the device directory. */
  paths: string[]
  /** The evidence ledger this commit's trailers describe. */
  evidence: {
    path: string
    present: boolean
    stateId: string | null
    plcChecksum: string | null
    objects: number
  }
  /** The exact message that would be recorded, trailers included. */
  message: string
}

/** What a completed commit did. */
export interface CommitResult extends CommitPlan {
  commit: GitCommit
}

/** The trailer line that marks a commit as produced by this workflow. */
const TRAILER_OP = 'Tia-Op: sync'

/** Whether a message already carries the trailer block (e.g. copied from `project_sync`). */
export function hasTrailerBlock(message: string): boolean {
  return /^Tia-Op:/mu.test(message)
}

/**
 * Validate and normalise the human part of a commit message.
 *
 * @param message - what the caller wants the commit to say.
 * @returns the trimmed message.
 * @throws {EngineeringContextError} when it is empty or longer than {@link MAX_COMMIT_MESSAGE_CHARS}.
 */
export function normalizeCommitMessage(message: string): string {
  const trimmed = typeof message === 'string' ? message.trim() : ''
  if (trimmed.length === 0) {
    throw new EngineeringContextError(
      'invalid_commit_message',
      'A commit needs a message: one line saying what changed and why, in the user\'s language.',
      { reason: 'empty' },
    )
  }
  if (trimmed.length > MAX_COMMIT_MESSAGE_CHARS) {
    throw new EngineeringContextError(
      'invalid_commit_message',
      `The commit message is ${trimmed.length} characters; the limit is ${MAX_COMMIT_MESSAGE_CHARS}.`,
      { reason: 'too_long', length: trimmed.length, limit: MAX_COMMIT_MESSAGE_CHARS },
    )
  }
  return trimmed
}

/**
 * The trailer block for one ledger state.
 *
 * @param evidence - the ledger the tree was built from, or null when it is missing.
 * @param reference - an optional provenance label (for example `SWT2@4af0a95`)
 *   echoing where imported objects came from; null to omit the line.
 * @returns the trailer lines, one per line.
 */
export function commitTrailers(evidence: EvidenceDocument | null, reference: string | null = null): string[] {
  const lines = [
    TRAILER_OP,
    `Tia-Checksum: ${evidence?.plcChecksum ?? 'unknown'}`,
    `Tia-State: ${evidence?.stateId ?? 'unknown'}`,
    'Tia-Manifest: updated',
  ]
  if (reference !== null && reference.length > 0) lines.push(`Reference: ${reference}`)
  return lines
}

/** The longest provenance label this plugin accepts. */
export const MAX_REFERENCE_CHARS = 200

/**
 * Validate the optional provenance label.
 *
 * A trailer is one line by definition: a newline would let the caller inject
 * arbitrary trailer lines (or a second paragraph) into a machine-readable block.
 *
 * @param value - the raw tool argument.
 * @returns the trimmed label, or null when none was supplied.
 * @throws {EngineeringContextError} when it is multiline or too long.
 */
export function normalizeCommitReference(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/[\r\n]/u.test(trimmed)) {
    throw new EngineeringContextError(
      'invalid_argument',
      'The reference must be one line: it becomes a single `Reference:` trailer in the commit message.',
      { parameter: 'reference' },
    )
  }
  if (trimmed.length > MAX_REFERENCE_CHARS) {
    throw new EngineeringContextError(
      'invalid_argument',
      `The reference is ${trimmed.length} characters; the limit is ${MAX_REFERENCE_CHARS}.`,
      { parameter: 'reference', length: trimmed.length, limit: MAX_REFERENCE_CHARS },
    )
  }
  return trimmed
}

/**
 * Attach the trailer block unless the caller already wrote one.
 *
 * @param message - the normalised caller message.
 * @param trailers - the trailer lines to append.
 * @returns the final message.
 */
export function composeCommitMessage(message: string, trailers: readonly string[]): string {
  if (hasTrailerBlock(message)) return message
  return `${message}\n\n${trailers.join('\n')}`
}

/**
 * Read what a commit of this device directory would record.
 *
 * @param scope - the resolved workspace.
 * @param device - the PLC and its source directory.
 * @param message - the caller's message; normalised here so a bad message fails before any write.
 * @returns the plan; `paths` empty means there is nothing to commit.
 * @throws {EngineeringContextError} when the message is invalid or the ledger is missing.
 */
export async function planCommit(
  scope: ResolvedScope,
  device: DeviceInfo,
  message: string,
  reference: string | null = null,
): Promise<CommitPlan> {
  const root = scope.workspace.path
  const normalized = normalizeCommitMessage(message)
  const evidenceFile = evidencePathForDevice(device.directory)
  let evidence: EvidenceDocument | null = null
  try {
    evidence = await readEvidence(evidenceFile)
  } catch {
    evidence = null
  }
  if (evidence === null) {
    throw new EngineeringContextError(
      'not_synced',
      `There is no readable evidence ledger at ${evidenceFile}, so a commit would record an unknown provenance. ` +
        'Run project_sync first: it writes the ledger a commit refers to.',
      { evidence: evidenceFile },
    )
  }

  // `ensureRepository` refuses rather than creating one, so a workspace without
  // history is an error with a next action, not an empty plan.
  await ensureRepository(root)
  const relative = gitPath(root, device.directory)
  const paths = porcelainPaths(await statusPaths(root, [relative]))

  return {
    device,
    relative,
    paths,
    evidence: {
      path: evidenceFile,
      present: true,
      stateId: evidence.stateId,
      plcChecksum: evidence.plcChecksum,
      objects: evidence.objects.size,
    },
    message: composeCommitMessage(normalized, commitTrailers(evidence, reference)),
  }
}

/**
 * Commit exactly the device directory.
 *
 * @param scope - the resolved workspace.
 * @param device - the PLC and its source directory.
 * @param message - the caller's message; the trailer block is appended when absent.
 * @param exec - the per-call execution context (cancellation).
 * @returns the plan plus what the commit did; `commit.committed` is false when nothing was dirty.
 * @throws {EngineeringContextError} when the message is invalid, the ledger is missing, or git fails.
 */
export async function runCommit(
  scope: ResolvedScope,
  device: DeviceInfo,
  message: string,
  exec: ToolRunContext,
  reference: string | null = null,
): Promise<CommitResult> {
  return await withLock(
    scope.workspace.path,
    'commit',
    async () => {
      const plan = await planCommit(scope, device, message, reference)
      if (exec.signal.aborted) {
        throw new EngineeringContextError('invalid_argument', 'The commit was cancelled before it ran.', {
          reason: 'cancelled',
        })
      }
      if (plan.paths.length === 0) {
        return { ...plan, commit: { committed: false, hash: null } }
      }
      const commit = await commitPaths(scope.workspace.path, [plan.relative], plan.message)
      return { ...plan, commit }
    },
    scope.config.stateDirName,
  )
}
